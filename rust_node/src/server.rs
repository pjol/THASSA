use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use tracing::error;

use crate::{types::UpdateRequest, workflow::FulfillmentService};

#[derive(Clone)]
struct AppState {
    service: Arc<FulfillmentService>,
}

pub fn router(service: Arc<FulfillmentService>) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/update", post(update))
        .with_state(AppState { service })
}

async fn health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "thassa-rust-node",
    }))
}

async fn update(
    State(state): State<AppState>,
    Json(request): Json<UpdateRequest>,
) -> impl IntoResponse {
    match state.service.fulfill_request(request).await {
        Ok(response) => (StatusCode::OK, Json(json!(response))).into_response(),
        Err(err) => {
            error!(error = %err, "HTTP update request failed");
            (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": err.to_string(),
                })),
            )
                .into_response()
        }
    }
}
