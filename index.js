const VK = require("vk-io").VK;
const youtubedl = require("youtube-dl")
const cp = require("child_process")
const toArray = require("stream-to-array")
var fs = require("fs");
var readline = require('readline');
var {google} = require('googleapis');
var OAuth2 = google.auth.OAuth2;
const ProgressBar = require("progress")
const yesno = require("yesno")
const Jimp = require("jimp")
let bar

const DEBUG = true

var SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
var TOKEN_DIR = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + '/.credentials/';
var TOKEN_PATH = TOKEN_DIR + 'youtube-nodejs-quickstart.json';

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
        if(fs.existsSync("stream_" + stream)) {
            console.log("Стрим уже скачан, обрезаю")
            upload_all(narezki, stream, client)
        } else {
            console.log("Стрим начнёт скачиваться через 5 секунд")
            await sleep(5)
            console.log("Загружаю стрим https://youtu.be/" + stream)
            let str = youtubedl(stream)
            str.on("info", res => {
                bar = new ProgressBar("Загрузка [:bar] :percent :etas", {
                    complete: String.fromCharCode(0x2588), 
                    total: parseInt(res.size) 
                })
            })
            str.on("data", data => {
                bar.tick(data.length)
            })
            toArray(str)
                .then(async parts => {
                    let file = fs.createWriteStream("stream_" + stream);
                    for(let part of parts) {
                        file.write(part)
                    }
                    file.close()
                    console.log("Стрим успешно скачан.")
                    upload_all(narezki, stream, client)
            })
        }
    }
}

async function upload_all(narezki, stream, client) {
    let service = google.youtube('v3')
    for(let i = 0; i < narezki.length - 1; i++) {
        let narezka = narezki[i];
        console.log("Нарезка", narezka.name, narezka.time + "-" + narezki[i + 1].time)
        if(!(await yesno({
            question: "Обрезать?"
        }))) continue
        let proc_narezka = cp.spawn("ffmpeg", [
            "-ss", narezka.time,
            "-to", narezki[i + 1].time,
            "-i", "stream_" + stream,
            "-c", "copy",
            "-f", "flv",
            "-"
        ])
        let proc_screenshot = cp.spawn("ffmpeg", [
            "-ss", narezka.time, // начало
            "-i", "stream_" + stream,
            "-ss", "00:25", // 25 секунд после начала
            "-frames:v", "1",
            "-q:v", "1",
            "-f", "mjpeg",
            "-"
        ])
        proc_narezka.stdin.on("error", err => {
            console.log("Ffmpeg завершил работу: " + err.name)
        })
        proc_screenshot.stdin.on("error", err => {
            console.log("Ffmpeg завершил работу: " + err.name)
        })
        
        if(DEBUG) {
            proc_screenshot.stdout.pipe(fs.createWriteStream("thumbnail.jpg"))
            proc_narezka.stdout.pipe(fs.createWriteStream("narezka.mp4"))
        } else {
            console.log("Загружаю это на ютуб")
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
                        thumbnails: {
                            
                        }
                    }
                },
                part: ["status", "snippet"],
                media: {
                    mimeType: "video/flv",
                    body: proc_narezka.stdout
                }
            }, (err, video) => {
                if(err) {
                    console.error(err)
                    process.exit(1)
                }
                console.log(`Опубликована нарезка "${video.data.snippet.title}" (https://youtu.be/${video.data.id})`)
            })
        }
    }
}

function extract_metadata(entry) {
    let name = entry.substring(0, entry.lastIndexOf("(")).substring(entry.indexOf(") ") + 1).trim()
    let time = entry.split("(").pop().split(/\)/)[0].trim()
    let id = entry.split("\n")[1].split("https://youtu.be/")[1].split("?")[0]
    return { name, time, id }
}

function sleep(s) {
    return new Promise(resolve => {
        setTimeout(resolve, s * 1000)
    })
}