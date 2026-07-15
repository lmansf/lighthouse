//! Lighthouse local API server library — the router is exposed here so
//! integration tests can mount it on an ephemeral port.

pub mod auth;
pub mod routes;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;

pub fn app() -> Router {
    Router::new()
        .route("/api/rag", get(routes::rag_get).post(routes::rag_post))
        .route("/api/chat", post(routes::chat_post))
        .route("/api/tts", post(routes::tts_post))
        .route(
            "/api/profile",
            get(routes::profile_get).post(routes::profile_post),
        )
        .route("/api/connect", post(routes::connect_post))
        .route(
            "/api/model",
            get(routes::model_get)
                .post(routes::model_post)
                .delete(routes::model_delete),
        )
        .route("/api/open", post(routes::open_post))
        .route(
            "/api/upload",
            post(routes::upload_post)
                // The upload route enforces its own 25 MB/file + 200 MB/request
                // caps; the transport limit just needs to sit above them.
                .layer(DefaultBodyLimit::max(210 * 1024 * 1024)),
        )
        .route(
            "/api/settings",
            get(routes::settings_get).post(routes::settings_post),
        )
        .route("/api/diagnostics", get(routes::diagnostics_get))
        .layer(DefaultBodyLimit::max(10 * 1024 * 1024))
}
