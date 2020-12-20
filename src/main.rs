use rvk::methods::wall;
use rvk::objects::post::Post;
use rvk::{APIClient, Params};
use serde::Deserialize;
use std::error::Error;
use tokio::time::Duration;
use simple_logger::SimpleLogger;
use log::*;

const WALL_ID: i32 = -170704076;
const START_FROM: i64 = 0;

#[tokio::main]
async fn main() {
    SimpleLogger::new().with_level(LevelFilter::Info).init().unwrap();
    let api = APIClient::new(env!("BN_VK_TOKEN"));
    let mut last_post = START_FROM;
    // проверять каждые 30 минут
    loop {
        info!("Checking for new posts");
        check_posts(&api, &mut last_post).await;
        std::thread::sleep(Duration::from_secs(3));
    }
}

async fn check_posts(api: &APIClient, last_post: &mut i64) {
    let mut params = Params::new();
    params.insert("owner_id".to_string(), WALL_ID.to_string());
    params.insert("offset".to_string(), 1.to_string());
    params.insert("count".to_string(), 1.to_string());

    let res = wall::get::<Posts>(api, params).await.expect("Не удалось загрузить посты");

    for post in res.items {
        let id = post.id;
        let date = post.date;
        if date <= *last_post {
            continue
        }
        info!("Post {}: {:?}", id, process_post(post));
        *last_post = date;
    }
}

fn process_post(post: Post) -> Result<(), Box<dyn Error>> {
    Ok(())
}

#[derive(Deserialize)]
pub struct Posts {
    count: i32,
    items: Vec<Post>,
}
