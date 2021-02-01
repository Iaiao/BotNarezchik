const cp = require("child_process");
const toArray = require("stream-to-array");
const fs = require("fs")
const Jimp = require("jimp");
const DEBUG = process.env.DEBUG;
class Utils {
    constructor(client, vk){
        this.client = client;
        this.vk = vk;
    }
    async parse(post) {
        let response = await this.vk.api.wall.getById({
            posts: post
        })
        let text = response[0]?.text
        let utext = text?.split(/\nОсновной: *\n/)?.[1]?.split(/\nНочной: *\n/)?.[0] ?? text?.split(/\nНочной: *\n/)?.[0]
        let streams = {}
        for(let entry of utext?.split(/\n\s*\n/) ?? []) {
            try {
                let narezka = this.extract_metadata(entry)
                if(!streams[narezka.id]) streams[narezka.id] = []
                streams[narezka.id].push(narezka)
            } catch(e) {
                console.log("Ой, а как какать? " + e)
            }
        }
        return streams
    }
    
    upload(service, narezka, time_end) {
        return new Promise(async (resolve, reject) => {
            let status;
            console.log("Нарезка", narezka.name, narezka.time + "-" + time_end)
            let proc_screenshot = cp.spawn("ffmpeg", [
                "-ss", narezka.time, // начало
                "-i", "stream_" + narezka.id + ".mp4",
                "-ss", "00:25", // 25 секунд после начала
                "-frames:v", "1",
                "-q:v", "1",
                "-f", "mjpeg",
                "-"
            ])
            proc_screenshot.stdin.on("error", err => {
                console.log("Ffmpeg завершил работу: " + err.name)
            })
            //let thumbnail = this.create_thumbnail(toArray(proc_screenshot.stdout))
            let proc_narezka = cp.spawn("ffmpeg", [
                //"-v", "quiet",
                "-stats",
                "-ss", narezka.time,
                "-to", time_end,
                "-i", "stream_" + narezka.id + ".mp4",
                "-i", "intro.mp4",
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
                console.log("Tags: ", this.generate_tags(narezka.name));
                (await thumbnail).pipe(fs.createWriteStream("thumbnail.jpg"))
                proc_narezka.stdout.pipe(fs.createWriteStream("narezka.mkv"))
                console.log("Piping")
                proc_narezka.on("close", resolve)
            } else {
                console.log("Загружаю это на ютуб");
                service.videos.insert({
                    auth: this.client,
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
    Стрим: https://youtu.be/${narezka.id}?t=${this.timeToSeconds(narezka.time)}s
    
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
                            tags: this.generate_tags(narezka.name)
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
                        // service.thumbnails.set({
                        //     auth: this.client,
                        //     videoId: video.data.id,
                        //     media: {
                        //         body: await thumbnail
                        //     }
                        // }).then(_ => {
                        //     console.log("Превью загружено")
                        //     resolve()
                        // }).catch(err => {
                        //     reject("Возникла ошибка при загрузке превью: " + err)
                        // })
                    }
                })
            }
        })
    }
    
    generate_tags(name) {
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
    
    create_thumbnail(screenshot) {
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
    
    extract_metadata(entry) {
        let name = entry.substring(0, entry.split("\n")[0].lastIndexOf("(")).substring(entry.indexOf(") ") + 1).trim()
        let time = entry.split("\n")[0].split("(").pop().split(/\)/)[0].trim()
        let id = entry.split("\n")[1].split("https://youtu.be/")[1].split("?")[0]
        return { name, time, id }
    }
    
    timeToSeconds(str) {
        let [h, m, s] = str.split(":")
        if(s === undefined) {
            s = m
            m = h
            h = "0"
        }
        return parseInt(s) + parseInt(m) * 60 + parseInt(h) * 60 * 60
    }
}

module.exports = Utils