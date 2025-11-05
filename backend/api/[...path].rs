use backend::api::{
    HealthResponse,
    order::{PerpOrderRequest, mock_order_payload, process_perp_order},
    user::{mock_user_payload, user_profile_payload},
};
use lambda_http::http::{self, Method, StatusCode};
use serde::Serialize;
use serde_json::json;
use tracing::error;
use vercel_runtime::{Body, Error, Request, RequestPayloadExt, Response, run};

#[tokio::main]
async fn main() -> Result<(), Error> {
    run(handler).await
}

async fn handler(req: Request) -> Result<Response<Body>, Error> {
    let method = req.method().clone();
    let raw_path = req.uri().path();
    let trimmed = raw_path.trim_end_matches('/');
    let normalized = trimmed
        .trim_start_matches("/api")
        .trim_start_matches('/')
        .to_string();

    tracing::info!(%method, %raw_path, %normalized, "handling vercel request");

    if method == Method::OPTIONS && raw_path.starts_with("/api") {
        return empty_cors(StatusCode::NO_CONTENT);
    }

    if method == Method::GET && normalized == "health" {
        return json_response(&HealthResponse::ok(), StatusCode::OK);
    }

    if method == Method::GET && normalized == "orders/mock" {
        return json_response(&mock_order_payload(), StatusCode::OK);
    }

    if method == Method::GET && normalized == "users/me" {
        return json_response(&user_profile_payload(), StatusCode::OK);
    }

    if method == Method::GET && normalized == "users/mock" {
        return json_response(&mock_user_payload(), StatusCode::OK);
    }

    if method == Method::POST && normalized == "orders/perp" {
        let payload = match req.payload::<PerpOrderRequest>() {
            Ok(Some(payload)) => payload,
            Ok(None) => {
                return json_response(
                    &json!({ "error": "Missing request body" }),
                    StatusCode::BAD_REQUEST,
                );
            }
            Err(err) => {
                error!(?err, "failed to deserialize order payload");
                return json_response(
                    &json!({ "error": "Invalid request body" }),
                    StatusCode::BAD_REQUEST,
                );
            }
        };

        let accepted = process_perp_order(payload).await;
        return json_response(&accepted, StatusCode::OK);
    }

    json_response(&json!({ "error": "Not Found" }), StatusCode::NOT_FOUND)
}

fn json_response<T: Serialize>(value: &T, status: StatusCode) -> Result<Response<Body>, Error> {
    let body = serde_json::to_string(value)?;
    let response = with_cors(Response::builder().status(status))
        .header("Content-Type", "application/json")
        .body(Body::Text(body))?;
    Ok(response)
}

fn empty_cors(status: StatusCode) -> Result<Response<Body>, Error> {
    let response = with_cors(Response::builder().status(status)).body(Body::Empty)?;
    Ok(response)
}

fn with_cors(builder: http::response::Builder) -> http::response::Builder {
    builder
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", "*")
        .header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
}
