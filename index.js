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
const gi = require('node-gtk')
const Gtk = gi.require('Gtk', '3.0')

const DEBUG = process.env.DEBUG == "TRUE"

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload']
const TOKEN_DIR = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + '/.credentials/'
const TOKEN_PATH = TOKEN_DIR + 'youtube-nodejs-quickstart.json'

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
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token))
    process.exit(0)
}

const vk = new VK({
    token: process.env.TOKEN
})

let win, status
async function run(client) {
    gi.startLoop()
    Gtk.init()

    const builder = Gtk.Builder.newFromFile(__dirname + "/ui.glade")
    win = builder.getObject("mainWindow")
    let post_url_entry = builder.getObject("postUrlEntry")
    let button = builder.getObject("startButton")
    let box = builder.getObject("box")

    win.setDefaultSize(1280, 720)
    win.setTitle("Бот Обрубка")
    win.on("destroy", () => {
        process.exit(0)
    })
    let streams = {}
    let checkboxes = {}
    post_url_entry.on("changed", () => {
        Object.values(checkboxes).forEach(widget => box.remove(widget))
        checkboxes = {}
        box.showAll()
        if(/^(https?:\/\/)?(www\.)?vk\.com\/[0-9_a-zA-Z]+\?w=wall-?\d+_\d+$/i.test(post_url_entry.getText())) {
            let post = post_url_entry.getText().split("?w=wall")[1]
            parse(post).then(result => {
                streams = result
                for(let [stream, narezki] of Object.entries(streams)) {
                    let i = 0
                    for(let narezka of narezki) {
                        let widget = Gtk.CheckButton.newWithLabel(narezka.name, "d")
                        checkboxes[stream + " " + i++] = widget
                        box.packStart(widget, true, true, 2)
                    }
                }
                button.setSensitive(true)
                box.showAll()
            }).catch(err => {
                console.error(err)
            })
        } else {
            button.setSensitive(false)
            box.showAll()
        }
    })
    button.getChild().setMarkup('<span size="xx-large">Начать обрезание</span>')
    button.setSensitive(false)
    async function onButtonClick() {
        let narezki = []
        for(let [narezka, widget] of Object.entries(checkboxes)) {
            narezki.push({
                enabled: widget.active,
                ...streams[narezka.split(" ")[0]][parseInt(narezka.split(" ")[1])]
            })
        }
        narezki.push({time: "12:00:00"})
        post_url_entry.setText("")
        win.setTitle("Бот Обрубка (генерация интро)")
        win.showAll()
        await require("./introgen")(process.env.YTA_TOKEN)
        let service = google.youtube('v3')
        for(let i = 0; i < narezki.length - 1; i++) {
            if(!narezki[i].enabled) continue
            win.setTitle(`Обрубка #${i + 1} > ${narezki[i].name} (00:00:00.00)`)
            win.showAll()
            let interval = setInterval(() => {
                win.setTitle(`Обрубка #${i + 1} > ${narezki[i].name} (${status})`)
                win.show()
            }, 100)
            await upload(service, client, narezki[i], narezki[i + 1].time)
            clearInterval(interval)
        }
        win.setTitle("Бот Обрубка")
        win.showAll()
        let dialog = new Gtk.MessageDialog(win, Gtk.DialogFlags.MODAL, Gtk.MessageType.INFO, Gtk.ButtonsType.NONE)
        dialog.addButton("Готово", 42)
        dialog.setDefaultSize(300, 1)
        dialog.setTitle("Все нарезки опубликованы")
        dialog.run()
        dialog.destroy()
    }
    button.on("released", onButtonClick)
    button.on("key-press-event", event => {
        if(event.keyval == 65293 /* ENTER */) {
            onButtonClick()
        }
    })

    win.showAll()
    Gtk.main()
}

async function parse(post) {
    let response = await vk.api.wall.getById({
        posts: post
    })
    let text = response[0]?.text
    let utext = text?.split(/\nОсновной: *\n/)?.[1]?.split(/\nНочной: *\n/)?.[0] ?? text?.split(/\nНочной: *\n/)?.[0]
    let streams = {}
    for(let entry of utext?.split(/\n\s*\n/) ?? []) {
        try {
            let narezka = extract_metadata(entry)
            if(!streams[narezka.id]) streams[narezka.id] = []
            streams[narezka.id].push(narezka)
        } catch(e) {
            console.log("Ой, а как какать? " + e)
        }
    }
    return streams
}

function upload(service, client, narezka, time_end) {
    return new Promise(async (resolve, reject) => {
        console.log("Нарезка", narezka.name, narezka.time + "-" + time_end)
        let proc_screenshot = cp.spawn("ffmpeg", [
            "-ss", narezka.time, // начало
            "-i", "stream_" + narezka.id + ".mkv",
            "-ss", "00:25", // 25 секунд после начала
            "-frames:v", "1",
            "-q:v", "1",
            "-f", "mjpeg",
            "-"
        ])
        proc_screenshot.stdin.on("error", err => {
            console.log("Ffmpeg завершил работу: " + err.name)
        })
        let thumbnail = create_thumbnail(toArray(proc_screenshot.stdout))
        let proc_narezka = cp.spawn("ffmpeg", [
            "-v", "quiet",
            "-stats",
            "-ss", narezka.time,
            "-to", time_end,
            "-i", "stream_" + narezka.id + ".mkv",
            "-i", "intro.mov",
            "-filter_complex", "[0:v][1:v]overlay=eof_action=pass[out]",
            "-map:v", "[out]",
            "-map", "0:a",
            "-c:v", "libx264",
            "-preset", "superfast",
            "-f", "matroska",
            "-"
        ])
        proc_narezka.stdin.on("error", err => {
            console.log("Ffmpeg завершил работу: " + err.name)
        })
        proc_narezka.stderr.pipe(process.stderr)
        proc_narezka.stderr.on("data", data => {
            status = new String(data)?.split(" time=")?.[1]?.split(" ")?.[0]
        })

        if(DEBUG) {
            console.log("Tags: ", generate_tags(narezka.name));
            (await thumbnail).pipe(fs.createWriteStream("thumbnail.jpg"))
            proc_narezka.stdout.pipe(fs.createWriteStream("narezka.mkv"))
            console.log("Piping")
            proc_narezka.on("close", resolve)
        } else {
            console.log("Загружаю это на ютуб");
            service.videos.insert({
                auth: client,
                autoLevels: true,
                notifySubscribers: false,
                stabilize: true,
                requestBody: {
                    status: {
                        embeddable: true,
                        madeForKids: false,
                        privacyStatus: "public"
                    },
                    snippet: {
                        title: narezka.name,
                        description: `В этой нарезке - ${narezka.name}
Поставь лайк и подпишись!
Стрим: https://youtu.be/${narezka.id}?t=${timeToSeconds(narezka.time)}s

=== КАК ПОПАСТЬ В ВИДЕО ===
Пиши комментарии:
1 слово = 1 балл
1 лайк = 2 балла
Подписка = всё умножается на 2
Комментарий без лайка = всё умножается на 3
Спам и флуд = бан
ТОП 3 попадают в следующую нарезку
`,
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
                    reject("Возникла ошибка при загрузке видео: " + err)
                } else {
                    console.log(`Опубликована нарезка "${video.data.snippet.title}" (https://youtu.be/${video.data.id})`)
                    service.thumbnails.set({
                        auth: client,
                        videoId: video.data.id,
                        media: {
                            body: await thumbnail
                        }
                    }).then(_ => {
                        console.log("Превью загружено")
                        resolve()
                    }).catch(err => {
                        reject("Возникла ошибка при загрузке превью: " + err)
                    })
                }
            })
        }
    })
}

function generate_tags(name) {
    let words = name.split(" ").map(word => word.replace(/,/g, ""))
    let tags = "пятёрка,пятерка,пятерка нарезки,бот нарезки,бот нарезки пятёрки".split(",")
    for(let word of words) {
        word = word.toLowerCase()
        if(Math.random() > 0.15) tags.push("пятёрка " + word)
        if(Math.random() > 0.15) tags.push("пятерка " + word)
        if(Math.random() > 0.75) tags.push(word)
        if(Math.random() > 0.65) tags.push(word + " пятерка")
    }
    for(let i = 0; i < words.length - 1; i++) {
        if(Math.random() > 0.25) tags.push(words[i] + " " + words[i + 1])
    }
    tags.concat("фуга тв,фуга тв нарезка,пятёрка смотрит,пятёрка реакция,нарезки пятёрка,5opka,пятерка пятерка,пятёрка нарезка,пятерка нарезка,реакция пятерка".split(","))
    tags = tags.map(tag => tag.replace(/["'<>\/\\]/g, "")).map(tag => '"' + tag + '"');
    tags = [...new Set(tags)].join(",").substring(0, 499).split(",").map(a => a.replace(/"/g, ""))
    return tags
}

function create_thumbnail(screenshot) {
    return new Promise(async (resolve, _reject) => {
        let files = fs.readdirSync("frames/")
        let frame = files[Math.floor(Math.random() * files.length)]
        Jimp.read(Buffer.concat(await screenshot)).then(image => {
            Jimp.read("frames/" + frame).then(frame => {
                image
                    .contrast(0.25)
                    .composite(frame, 0, 0)
                    .convolute([
                        [-1 / 2,    -1 / 2,  -1 / 2],
                        [ 1 / 2,      0.95,  -1 / 2],
                        [ 1 / 2,     1 / 2,   1 / 2]
                    ])
                    .resize(1280, 720)
                image.getBuffer(Jimp.MIME_JPEG, (_err, buf) => {
                    let stream = new Readable({
                        read() {
                            this.push(buf)
                            this.push(null)
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

function timeToSeconds(str) {
    let [h, m, s] = str.split(":")
    if(s === undefined) {
        s = m
        m = h
        h = "0"
    }
    return parseInt(s) + parseInt(m) * 60 + parseInt(h) * 60 * 60
}
