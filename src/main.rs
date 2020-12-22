use log::*;
use rvk::methods::wall;
use rvk::objects::post::Post;
use rvk::{APIClient, Params};
use serde::Deserialize;
use simple_logger::SimpleLogger;
use tokio::time::Duration;
use std::process::{Command, Stdio};
use std::io::Write;

const TOKEN: &str = env!("BN_VK_TOKEN");
const WALL_ID: i32 = -170704076;
const START_FROM: i64 = 0;

#[tokio::main]
async fn main() {
    SimpleLogger::new()
        .with_level(LevelFilter::Info)
        .init()
        .unwrap();
    let api = APIClient::new(TOKEN);
    let mut last_post = START_FROM;
    // проверять каждые 30 минут
    loop {
        info!("Проверяю посты");
        check_posts(&api, &mut last_post).await;
        std::thread::sleep(Duration::from_secs(60 * 30));
    }
}

async fn check_posts(api: &APIClient, last_post: &mut i64) {
    let mut params = Params::new();
    params.insert("owner_id".to_string(), WALL_ID.to_string());
    params.insert("offset".to_string(), 1.to_string());
    params.insert("count".to_string(), 100.to_string());

    let res = wall::get::<Posts>(api, params)
        .await
        .expect("Не удалось загрузить посты");

    for post in res.items {
        let id = post.id;
        let date = post.date;
        if date <= *last_post {
            continue;
        }
        info!("Post {}: {:?}", id, process_post(post).await);
        *last_post = date;
    }
}

async fn process_post(post: Post) -> Option<usize> {
    let content = post
        .text
        .split("Интересные моменты стрима:")
        .nth(1)?
        .replace("Основной:", "")
        .replace("Ночной:", "")
        .replace("\n \n", "\n\n"); // хз зачем там пробел всегда стоит ну ок
    let videos = content
        .split("\n\n")
        .filter_map(|entry| {
            if let [entry, videos @ ..] = entry.lines().collect::<Vec<&str>>().as_slice() {
                let video = videos
                    .iter()
                    .filter_map(|video| video.split("/").nth(3)?.split("?").nth(0))
                    // пока что ничего не мёрджить, брать только первый кусок, потому что в большинстве случаев он только один
                    .next()?;
                let entry = entry.split(")").nth(1)?;
                Some([entry, video])
            } else {
                None
            }
        })
        .filter_map(|[entry, video_id]| {
            let entry = entry.trim();
            if let [name, time] = entry.split("(").collect::<Vec<&str>>().as_slice() {
                Some(Video {
                    name: name.trim().to_string(),
                    time: time.to_string(),
                    id: video_id.to_string(),
                })
            } else {
                None
            }
        })
        .collect::<Vec<Video>>();
    let mut i = 0;
    let mut streams: Vec<Stream> = Vec::new();
    for video in videos {
        if streams
            .iter()
            .find(|stream| stream.id == video.id)
            .is_some()
        {
            streams
                .iter_mut()
                .find(|stream| stream.id == video.id)?
                .narezki
                .push((video.time, video.name))
        } else {
            streams.push(Stream {
                id: video.id,
                narezki: vec![(video.time, video.name)],
            })
        }
        i += 1;
    }
    for stream in streams {
        process_stream(stream).await
    }
    Some(i)
}

async fn process_stream(mut stream: Stream) {
    let narezki = stream.get_narezki();
    if !narezki.is_empty() {
        // короткий стрим для тестов, не скачивать же все 5 часов
        if cfg!(debug_assertions) {
            stream.id = "g8I2T_aDXGE".to_string();
        }
        if let youtube_dl::YoutubeDlOutput::SingleVideo(video_info) =
            youtube_dl::YoutubeDl::new(stream.id.clone())
                .socket_timeout("15")
                .run()
                .unwrap()
        {
            let formats = video_info
                .formats
                .expect("Невозможно получить форматы для загрузки");
            let format = formats
                .iter()
                .filter(|f| f.vcodec.is_some() && f.vcodec.as_ref().unwrap() != "none" && f.acodec.is_some() && f.acodec.as_ref().unwrap() != "none")
                .max_by_key(|f| f.height)
                .expect("Не найдено видео форматов для загрузки");
            info!("Видео кодек: {}", format.vcodec.as_ref().unwrap());
            info!("Аудио кодек: {}", format.acodec.as_ref().unwrap());

            // Для форматов прямых трансляций в url сразу ссылка на стрим, а не на манифест
            info!("Загружается стрим стрим {}", video_info.title);
            let bytes = reqwest::get(format.url.as_ref().unwrap())
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap();
            info!("Стрим загрузился: {}G", bytes.len() as f64 / 1024.0 / 1024.0 / 1024.0);
            for narezka in narezki {
                println!("{:?}", narezka);
                // пока что так
                let mut handle = Command::new("ffmpeg")
                    .arg("-y")
                    .arg("-ss").arg(narezka.start)
                    .arg("-i").arg("pipe:0")
                    .arg("-to").arg(narezka.end)
                    .arg("-c").arg("copy")
                    .arg("narezka.mp4") // пока что сюда
                    .stdin(Stdio::piped())
                    .spawn()
                    .expect("Не получилось запустить ffmpeg");
                handle.stdin.as_mut().unwrap().write(&*bytes).expect("Не удалось передать видео в ffmpeg");
                handle.wait().unwrap();
                break;
            }
        }
    }
}

#[derive(Deserialize)]
struct Posts {
    #[allow(unused)]
    count: i32,
    items: Vec<Post>,
}

#[derive(Debug)]
struct Video {
    name: String,
    id: String,
    time: String,
}

#[derive(Debug)]
struct Stream {
    // Vec<(таймкод, название)>
    narezki: Vec<(String, String)>,
    id: String,
}

impl Stream {
    fn get_narezki(&self) -> Vec<Narezka> {
        let mut narezki = Vec::new();
        let mut iter = self.narezki.iter().peekable();
        while let (Some((start_time, name)), Some((end_time, _))) = (iter.next(), iter.peek()) {
            narezki.push(Narezka {
                start: start_time.to_string(),
                end: end_time.to_string(),
                name: name.to_string(),
            })
        }
        narezki
    }
}

#[derive(Debug)]
struct Narezka {
    start: String,
    end: String,
    name: String,
}
