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
let bar, service

var SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
var TOKEN_DIR = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + '/.credentials/';
var TOKEN_PATH = TOKEN_DIR + 'youtube-nodejs-quickstart.json';

fs.readFile('client_secret.json', function processClientSecrets(err, content) {
    if (err) {
        console.log('Error reading client_secters.json: ' + err);
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
    console.log('Log in: ', authUrl);
    var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question('Enter the code: ', function(code) {
        rl.close();
        oauth2Client.getToken(code, function(err, token) {
            if (err) {
                console.log('Error', err);
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
        console.log('Token is stored in ' + TOKEN_PATH);
    })
}



const vk = new VK({
	  token: process.env.TOKEN
})

async function run(client) {
    service = google.youtube('v3');
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
            console.log("Error:\n" + e)
        }
    }
    for(let [stream, narezki] of Object.entries(streams)) {
        if(fs.existsSync("stream_" + stream)) {
            console.log("Livestream is already downloaded, trimming")
            upload_all(narezki, stream, client)
        } else {
            console.log("Livestream will start downloading in 5 seconds")
            await sleep(5)
            console.log("Downloading https://youtu.be/" + stream)
            let str = youtubedl(stream)
            str.on("info", res => {
                bar = new ProgressBar("Downloading [:bar] :percent :etas", {
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
                    console.log("Downloaded livestream successfully.")
                    upload_all(narezki, stream, client)
            })
        }
    }
}

async function upload_all(narezki, stream, client) {
    narezki.push({time: "12:00:00"})
    for(let i = 0; i < narezki.length - 1; i++) {
        let narezka = narezki[i];
        console.log("Highlight:", narezka.name, narezka.time + "-" + narezki[i + 1].time)
        if(!(await yesno({
            question: "Upload?"
        }))) continue
        let proc = cp.spawn("ffmpeg", [
            "-ss", narezka.time,
            "-to", narezki[i + 1].time,
            "-i", "stream_" + stream,
            "-c", "copy",
            "-f", "flv",
            "-"
        ])
        proc.stdin.on("error", err => {
            console.log("Ffmpeg is done: " + err.name)
        })
        console.log("Uploading to YouTube")
        let video = await service.videos.insert({
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
                }
            },
            part: ["status", "snippet"],
            media: {
                mimeType: "video/flv",
                body: proc.stdout
            }
        })
        console.log(`Highlight published "${narezka.name}": https://youtu.be/${video.id}`)
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