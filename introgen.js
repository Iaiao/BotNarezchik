const UserCounter = require("ytactive")
const Jimp = require("jimp")
const cp = require("child_process")

const CHANNEL = "UCCxqOWFBxFIEgw4yMk16XEw"
const exclude = []

let gen = token => new Promise((resolve, _reject) => {
    let counter = new UserCounter(token, comment => new Promise((resolve, _reject) => {
        let points = comment.like_count * 1 + Math.min(comment.text.split(" ").filter((w, i, a) => a.indexOf(w) == i).filter(a => a.length > 2).length, 30) * 2
        if(comment.like_count === 0) points *= 3
        comment.isSubscribed(CHANNEL, counter).then(is => resolve(is ? points * 2 : points)).catch(_err => resolve(points))
    }))
    let results = {}
    counter.count(CHANNEL)
        .then(comments => {
            let entries = Object.entries(comments)
            entries.sort((a, b) => b[1] - a[1])
            entries = entries.filter(e => !exclude.includes(e[0]))
            entries = entries.slice(0, 3)
            for(let [id, points] of entries) {
                results[id] = points
            }
            return counter.client.channels.list({
                id: entries.map(a => a[0]),
                part: [ "snippet", "id" ]
            })
        }).then(response => Promise.all(response.data.items.map(async item => {
            return {
                ava: await Jimp.read(item.snippet.thumbnails.default.url),
                title: item.snippet.title,
                id: item.id
            }
        }))).then(commenters => {
            new Jimp(1920, 1080, async (err, image) => {
                if(err) {
                    console.error(err)
                } else {
                    const circle = await Jimp.read("circle.png")
                    const border = await Jimp.read("border.png")
                    const font = await Jimp.loadFont("Aqum.fnt")
                    const rect = await Jimp.create(1920 - 301*2 + 200*2, 300, "#00000077")
                    let i = 0
                    image.composite(rect, 301 - 200, 600 + 240 + 50)
                    for(let { ava, title, id } of commenters) {
                        image.print(font, 301 + (i * 526), 555 + 260 + 100, title)
                        image.print(font, 301 + (i * 526) + 100, 555 + 260 + 100 + 50, results[id].toString())
                        image.composite(ava.resize(260, 260).mask(circle).composite(border, 0, 0), 301 + (i++ * 526), 600)
                    }
                    image.print(font, 555, 1030, "СМОТРИ ОПИСАНИЕ ЧТОБЫ ПОПАСТЬ СЮДА")
                    image.write("commenters.png", () => {
                        let proc = cp.spawn("ffmpeg", "-y -i intro.mp4 -loop 1 -i commenters.png -loop 1 -i subscribe.png -filter_complex [0:v]chromakey=#00ff00:0.3:0.1[c];[1:v]fade=in:50:20[f];[2:v]fade=in:90:10[s];[f]fade=out:90:10[f];[f][s]overlay[i];[i][c]overlay[out] -map:v [out] -c:v png -t 4 intro.mov".split(" "))
                        proc.stderr.pipe(process.stderr)
                        proc.on("close", () => {
                            resolve()
                        })
                    })
                }
            })
        }).catch(err => {
            console.error("ERROR:")
            console.error(err)
        })
})

module.exports = gen