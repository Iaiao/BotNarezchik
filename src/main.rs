use std::io::{Cursor, Write};
use std::process::{Command, Stdio};

use google_youtube3::{VideoSnippet, YouTube};
use hyper::Client;
use log::*;
use rvk::methods::wall;
use rvk::objects::post::Post;
use rvk::{APIClient, Params};
use serde::Deserialize;
use simple_logger::SimpleLogger;
use tokio::time::Duration;
use yup_oauth2::{Authenticator, AuthenticatorDelegate, DiskTokenStorage};

const TOKEN: &str = env!("BN_VK_TOKEN");
const WALL_ID: i32 = -170704076;
const START_FROM: i64 = 0;

#[tokio::main]
async fn main() {
    SimpleLogger::new()
        .with_level(LevelFilter::Info)
        .init()
        .unwrap();

    let secret = yup_oauth2::read_application_secret(
        &std::fs::read_dir(".")
            .unwrap()
            .filter(|file| {
                file.is_ok()
                    && file
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_str()
                    .unwrap()
                    .starts_with("client_secret_")
                    && file
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_str()
                    .unwrap()
                    .ends_with(".apps.googleusercontent.com.json")
            }).next().expect("Файл client_secret_****.apps.googleusercontent.com.json не найден! Загрузи его на странице реквизитов").unwrap().path().into_boxed_path(),
    ).expect("Что-то не так с файлом приложения");
    let token_storage = DiskTokenStorage::new(&"tokens.json".to_string()).unwrap();
    let auth = Authenticator::new(
        &secret,
        BotAuthenticatorDelegate,
        hyper::Client::with_connector(hyper::net::HttpsConnector::new(
            hyper_rustls::TlsClient::new(),
        )),
        token_storage,
        Some(yup_oauth2::FlowType::InstalledInteractive),
    );
    let mut hub = YouTube::new(
        hyper::Client::with_connector(hyper::net::HttpsConnector::new(
            hyper_rustls::TlsClient::new(),
        )),
        auth,
    );

    let api = APIClient::new(TOKEN);
    let mut last_post = START_FROM;
    // проверять каждые 30 минут
    loop {
        info!("Проверяю посты");
        check_posts(&api, &mut last_post, &mut hub).await;
        std::thread::sleep(Duration::from_secs(60 * 30));
    }
}

async fn check_posts(
    api: &APIClient,
    last_post: &mut i64,
    hub: &mut YouTube<Client, Authenticator<BotAuthenticatorDelegate, DiskTokenStorage, Client>>,
) {
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
        info!("Post {}: {:?}", id, process_post(post, hub).await);
        *last_post = date;
    }
}

async fn process_post(
    post: Post,
    hub: &mut YouTube<Client, Authenticator<BotAuthenticatorDelegate, DiskTokenStorage, Client>>,
) -> Option<usize> {
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
        process_stream(stream, hub).await
    }
    Some(i)
}

async fn process_stream(
    mut stream: Stream,
    hub: &mut YouTube<Client, Authenticator<BotAuthenticatorDelegate, DiskTokenStorage, Client>>,
) {
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
            // TODO пока что ничего не мёрджим, качество подгоню позже
            let format = formats
                .iter()
                .filter(|f| {
                    f.vcodec.is_some()
                        && f.vcodec.as_ref().unwrap() != "none"
                        && f.acodec.is_some()
                        && f.acodec.as_ref().unwrap() != "none"
                })
                .max_by_key(|f| f.height)
                .expect("Не найдено видео форматов для загрузки");
            info!("Видео кодек: {}", format.vcodec.as_ref().unwrap());
            info!("Аудио кодек: {}", format.acodec.as_ref().unwrap());
            info!("Загружаю {}", format.url.as_ref().unwrap());

            // Для форматов прямых трансляций в url сразу ссылка на стрим, а не на манифест
            info!("Загружается стрим стрим {}", video_info.title);
            let bytes = reqwest::get(format.url.as_ref().unwrap())
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap();
            info!(
                "Стрим загрузился: {}G",
                bytes.len() as f64 / 1024.0 / 1024.0 / 1024.0
            );
            for narezka in narezki {
                info!("Информация о нарезке: {:?}", narezka);
                // пока что так, потом как-то что-то с ffmpeg-next придумаю
                let mut handle = Command::new("ffmpeg")
                    .arg("-y")
                    .arg("-ss")
                    .arg(narezka.start)
                    .arg("-i")
                    .arg("pipe:0")
                    .arg("-to")
                    .arg(narezka.end)
                    .arg("-c")
                    .arg("copy")
                    .arg("narezka.mp4")
                    .stdin(Stdio::piped())
                    .spawn()
                    .expect("Не получилось запустить ffmpeg");
                handle
                    .stdin
                    .as_mut()
                    .unwrap()
                    .write(&*bytes)
                    .expect("Не удалось передать видео в ffmpeg");
                let status = handle.wait().unwrap();
                info!(
                    "Ffmpeg завершил работу со статусом {}",
                    status.code().unwrap()
                );

                // upload
                let video = std::fs::read("narezka.mp4")
                    .expect("Что-то пошло не так и файл `narezka.mp4` не может быть открыт");
                let mut vid = google_youtube3::Video::default();
                vid.snippet = Some(VideoSnippet {
                    description: Some("Описание нарезки".to_string()),
                    tags: None,
                    default_audio_language: None,
                    channel_id: None,
                    published_at: None,
                    live_broadcast_content: None,
                    default_language: None,
                    thumbnails: None,
                    title: Some(narezka.name),
                    category_id: None,
                    localized: None,
                    channel_title: None,
                });
                let (res, vid) = hub
                    .videos()
                    .insert(vid)
                    .upload(
                        Cursor::new(video),
                        "application/octet-stream".parse().unwrap(),
                    )
                    .expect("Не удалось загрузить видео");
                info!("Загружено: {} {}", res.status, vid.id.unwrap());
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

struct BotAuthenticatorDelegate;

impl AuthenticatorDelegate for BotAuthenticatorDelegate {
    fn connection_error(&mut self, e: &hyper::Error) -> yup_oauth2::Retry {
        error!("Ошибка: {}", e);
        yup_oauth2::Retry::Abort
    }

    fn token_storage_failure(
        &mut self,
        _is_set: bool,
        e: &dyn std::error::Error,
    ) -> yup_oauth2::Retry {
        error!("Ошибка: {}", e);
        yup_oauth2::Retry::Abort
    }

    fn token_refresh_failed(&mut self, error: &String, error_description: &Option<String>) {
        error!(
            "Ошибка: {}: {}",
            error,
            error_description.as_ref().unwrap_or(&"".to_string())
        );
    }

    fn present_user_url(&mut self, url: &String, need_code: bool) -> Option<String> {
        if need_code {
            info!("Зайди на {} и введи код: ", url);

            let mut code = String::new();
            std::io::stdin().read_line(&mut code).ok().map(|_| code)
        } else {
            error!("Зайди на {} и сделай что-то", url);
            None
        }
    }
}
