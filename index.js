const VK = require("vk-io").VK
const cp = require("child_process")
const toArray = require("stream-to-array")
const fs = require("fs")
const readline = require('readline')
const { google } = require('googleapis')
const OAuth2 = google.auth.OAuth2;
const yesno = require("yesno")
const Jimp = require("jimp")
const { Readable } = require("stream")

const DEBUG = process.env.DEBUG == "TRUE"

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
const TOKEN_DIR = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + '/.credentials/';
const TOKEN_PATH = TOKEN_DIR + 'youtube-nodejs-quickstart.json';

const BANNED_WORDS = [
    "смерт",
    "умер",
    "терр?ор",
    "войн",
    "убит",
    "порн.",
    "килл",
    "рейд",
    "г[оа]вн."
] // в группе вроде не так много бан-слов, поэтому думаю не стоит добавлять 1000000 слов

fs.readFile('client_secret.json', function processClientSecrets(err, content) {
    if (err) {
        console.log('Ошибка чтения файла с секретами: ' + err);
        return;
    }
    authorize(JSON.parse(content), run);
});

function authorize(credentials, callback) {
    var clientSecret = credentials.installed.client_secret;
    var clientId = credentials.installed.client_id;
    var redirectUrl = credentials.installed.redirect_uris[0];
    var oauth2Client = new OAuth2(clientId, clientSecret, redirectUrl);

    fs.readFile(TOKEN_PATH, function(err, token) {
        if (err) {
            getNewToken(oauth2Client, callback);
        } else {
            oauth2Client.credentials = JSON.parse(token);
            callback(oauth2Client);
        }
    });
}

function getNewToken(oauth2Client, callback) {
    var authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES
    });
    console.log('Войди в приложение по ссылке: ', authUrl);
    var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question('Введи код оттуда: ', function(code) {
        rl.close();
        oauth2Client.getToken(code, function(err, token) {
            if (err) {
                console.log('Ошибка получения токена', err);
                return;
            }
            oauth2Client.credentials = token;
            storeToken(token);
            callback(oauth2Client);
        });
    });
}

function storeToken(token) {
    try {
        fs.mkdirSync(TOKEN_DIR);
    } catch (err) {
        if (err.code != 'EEXIST') {
            throw err;
        }
    }
    fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) throw err;
        console.log('Токен сохранён в ' + TOKEN_PATH);
    })
}



const vk = new VK({
	  token: process.env.TOKEN
})

async function run(client) {
    let response = await vk.api.wall.getById({
        posts: "-170704076_" + process.env.POST
    })
    let text = response[0].text
    let utext = text.split(/\nОсновной: *\n/)[1].split(/\nНочной: *\n/)[0]
    let streams = {}
    for(let entry of utext.split(/\n\s*\n/)) {
        try {
            let narezka = extract_metadata(entry)
            if(!streams[narezka.id]) streams[narezka.id] = []
            streams[narezka.id].push(narezka)
            console.log(narezka)
        } catch(e) {
            console.log("Ой, а как какать?\n" + e)
        }
    }
    for(let [stream, narezki] of Object.entries(streams)) {
        narezki.push({ time: "12:00:00" })
        if(fs.existsSync("stream_" + stream + ".mkv")) {
            console.log("Стрим уже скачан, обрезаю")
            upload_all(narezki, stream, client)
        } else {
            console.log("Стрим начнёт скачиваться через 5 секунд")
            await sleep(5)
            console.log("Загружаю стрим https://youtu.be/" + stream)
            let youtubedl = cp.spawn("youtube-dl", [
                stream,
                "--merge-output-format", "mkv",
                "-o", "stream_" + stream,
            ])
            youtubedl.stdout.pipe(process.stdout)
            youtubedl.on("exit", (code, signal) => {
                if(code == 0) {
                    console.log("Стрим успешно скачан.")
                    upload_all(narezki, stream, client)
                } else {
                    console.error("Стрим не скачан с кодом " + code + " " + signal)
                }
            })
        }
    }
}

let allSelected = false

async function upload_all(narezki, stream, client) {
    process.stderr.setMaxListeners(50)
    let service = google.youtube('v3')
    for(let i = 0; i < narezki.length - 1; i++) {
        let narezka = narezki[i];
        console.log("Нарезка", narezka.name, narezka.time + "-" + narezki[i + 1].time)
        if(!(await yesno({
            question: "Обрезать?"
        }))) continue
        when_all_selected().then(async () => {
            let proc_screenshot = cp.spawn("ffmpeg", [
                "-ss", narezka.time, // начало
                "-i", "stream_" + stream + ".mkv",
                "-ss", "00:25", // 25 секунд после начала
                "-frames:v", "1",
                "-q:v", "1",
                "-f", "mjpeg",
                "-"
            ])
            proc_screenshot.stdin.on("error", err => {
                console.log("Ffmpeg завершил работу: " + err.name)
            })
            let thumbnail = create_thumbnail(Buffer.concat(await toArray(proc_screenshot.stdout)))
            let proc_narezka = cp.spawn("ffmpeg", [
                "-v", "quiet",
                "-stats",
                "-ss", narezka.time,
                "-to", narezki[i + 1].time,
                "-i", "stream_" + stream + ".mkv",
                "-i", "intro.mp4",
                "-filter_complex", "[1:v]colorkey=0x00ff00:0.5:0.1[ckout];[0:v][ckout]overlay[out]",
                "-map:v", "[out]",
                "-map:a", "0",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-f", "matroska",
                "-"
            ])
            proc_narezka.stdin.on("error", err => {
                console.log("Ffmpeg завершил работу: " + err.name)
            })
            proc_narezka.stderr.pipe(process.stderr)
        
            if(DEBUG) {
                console.log("Tags: ", generate_tags(narezka.name));
                (await thumbnail).pipe(fs.createWriteStream("thumbnail.jpg"))
                proc_narezka.stdout.pipe(fs.createWriteStream("narezka.mkv"))
            } else {
                console.log("Загружаю это на ютуб");
                service.videos.insert({
                    auth: client,
                    autoLevels: true,
                    notifySubscribers: false,
                    stabilize: true,
                    requestBody: {
                        status: {
                            madeForKids: false,
                            privacyStatus: "public"
                        },
                        snippet: {
                            title: narezka.name,
                            description: `В этой нарезке - ${narezka.name}
Поставь лайк и подпишись!
Стрим: https://youtu.be/${stream}?t=${narezka.time}`,
                            defaultAudioLanguage: "ru",
                            defaultLanguage: "ru",
                            tags: generate_tags(narezka.name)
                        }
                    },
                    part: ["status", "snippet"],
                    media: {
                        body: proc_narezka.stdout
                    }
                }, async (err, video) => {
                    if(err) {
                        console.log("Возникла ошибка при загрузке видео:")
                        console.error(err)
                    }
                    console.log(`Опубликована нарезка "${video.data.snippet.title}" (https://youtu.be/${video.data.id})`)
                    service.thumbnails.set({
                        auth: client,
                        videoId: video.data.id,
                        media: {
                            body: await thumbnail
                        }
                    }).then(_ => {
                        console.log("Превью загружено")
                    }).catch(err => {
                        console.log("Возникла ошибка при загрузке превью:")
                        console.error(err)
                    })
                })
            }
        })
    }
    allSelected = true
}

function when_all_selected() {
    return new Promise(async (resolve, reject) => {
        function a() {
            if(allSelected) {
                resolve()
            } else {
                setTimeout(a, 100)
            }
        }
        setTimeout(a, 100)
    })
}

function generate_tags(name) {
    let words = name.split(" ").map(word => word.replace(/,/g, ""))
    let tags = "пятёрка,пятерка,пятерка нарезки,бот нарезки,бот нарезки пятёрки,"
    for(let word of words) {
        word = word.toLowerCase()
        if(Math.random() > 0.2) tags += "пятёрка " + word + ","
        if(Math.random() > 0.2) tags += "пятерка " + word + ","
        if(Math.random() > 0.8) tags += word + ","
        if(Math.random() > 0.7) tags += word + " пятерка" + ","
    }
    for(let i = 0; i < words.length - 1; i++) {
        if(Math.random() > 0.3) tags += words[i] + " " + words[i + 1] + ","
    }
    for(let word of BANNED_WORDS) {
        tags = tags.replace(new RegExp("[^,].*" + word + ".*[^,]", "g"))
    }
    tags += "фуга тв,фуга тв нарезка,пятёрка смотрит,пятёрка реакция,нарезки пятёрка,5opka,пятерка пятерка,пятёрка нарезка,пятерка нарезка,реакция пятерка"
    tags = tags.substring(0, 465)
    return tags.split(",")
}

function create_thumbnail(screenshot) {
    return new Promise(async (resolve, reject) => {
        let files = fs.readdirSync("frames/")
        let frame = files[Math.floor(Math.random() * files.length)]
        Jimp.read(Buffer.from(screenshot)).then(image => {
            Jimp.read("frames/" + frame).then(frame => {
                image
                    .contrast(0.25)
                    .composite(frame, 0, 0)
                    .convolute([
                        [-1 / 3,    -1 / 3,  -1 / 3],
                        [ 1 / 3,      1.05,  -1 / 3],
                        [ 1 / 3,     1 / 3,   1 / 3]
                    ])
                image.getBuffer(Jimp.MIME_JPEG, (err, buf) => {
                    let stream = new Readable({
                        read() {
                            this.push(buf);
                            this.push(null);
                        }
                    })
                    resolve(stream)
                })
            })
        })
    })
}

function extract_metadata(entry) {
    let name = entry.substring(0, entry.split("\n")[0].lastIndexOf("(")).substring(entry.indexOf(") ") + 1).trim()
    let time = entry.split("\n")[0].split("(").pop().split(/\)/)[0].trim()
    let id = entry.split("\n")[1].split("https://youtu.be/")[1].split("?")[0]
    return { name, time, id }
}

function sleep(s) {
    return new Promise(resolve => {
        setTimeout(resolve, s * 1000)
    })
}