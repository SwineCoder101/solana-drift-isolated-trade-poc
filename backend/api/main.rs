use backend::api::{
    HealthResponse,
    order::{PerpOrderRequest, process_perp_order},
    user::user_profile_payload,
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
    let path = req.uri().path().to_owned();

    match (method, path.as_str()) {
        (Method::OPTIONS, path) if path.starts_with("/api/") => empty_cors(StatusCode::NO_CONTENT),
        (Method::GET, "/api/health") => json_response(&HealthResponse::ok(), StatusCode::OK),
        (Method::POST, "/api/orders/perp") => {
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
            json_response(&accepted, StatusCode::OK)
        }
        (Method::GET, "/api/users/me") => json_response(&user_profile_payload(), StatusCode::OK),
        _ => json_response(&json!({ "error": "Not Found" }), StatusCode::NOT_FOUND),
    }
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
