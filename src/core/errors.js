export class StageError extends Error {
  constructor(stage, errorType, message, details = {}) {
    super(message);
    this.name = "StageError";
    this.stage = stage;
    this.errorType = errorType;
    this.details = details;
  }
}
