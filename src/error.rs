use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// Error type for every handler. `Http` errors are shown to the user as-is;
/// `Internal` errors are logged and reported with a generic message.
#[derive(Debug)]
pub enum AppError {
    Http(StatusCode, String),
    Internal(anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::Http(StatusCode::BAD_REQUEST, message.into())
    }

    pub fn unauthorized() -> Self {
        Self::Http(StatusCode::UNAUTHORIZED, "Sign in to continue.".into())
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::Http(StatusCode::FORBIDDEN, message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::Http(StatusCode::NOT_FOUND, message.into())
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Http(StatusCode::CONFLICT, message.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Http(status, message) => (status, message),
            Self::Internal(error) => {
                tracing::error!("{error:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Something went wrong on the server. Your change was not saved.".into(),
                )
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(error: E) -> Self {
        Self::Internal(error.into())
    }
}
