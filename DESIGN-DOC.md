# Dolly - Design & Technical Specification

created: October 29, 2025 1:33 PM
created by: Sophie

*Author: Aidan Walker
Creation Date: 10/29/2025
Status: Draft*

---

# Table of Contents

- [Overview of chart creation process](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Step 1: Obtaining songs](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Step 2: Splitting a song into stems](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Step 3: Chart Generation](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Step 4: Chart Merging](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Step 5: Final conversion to .sng](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Step 6: Move the final .sng to the Clone Hero songs directory](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Error Handling & User Feedback](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [User Flow](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [System Architecture](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Difficulty Generator](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Public Functions](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Data Architecture](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [High Level Tests](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Quality Metrics](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)
- [Risks](Dolly%20-%20Design%20&%20Technical%20Specification%2029b4f233166c809081b6eacf0191715a.md)

# Overview of chart creation process

1. Take in a song
    1. Could be a YouTube link possibly
        1. YouTube links are difficult because YouTube locks down downloading of videos with copyrighted music
        2. If implemented, this feature must be clearly marked as experimental and optional
        3. The user should be explicitly informed that they are responsible for ensuring they have the legal right to process the audio
    2. Could be a song file
        1. For compatibility, Dolly should support the most common audio formats, including: `wav`, `mp3`, `flac`, and `ogg`
        2. Large files should be streamed or chunked internally to avoid excessive memory usage
        3. File validation should occur immediately to fail fast on unsupported or corrupted files
2. Split it into its stems
    1. There are many ways to do this, all involving some kind of AI. Since speed isn’t necessarily a priority, Dolly will favor accuracy and consistency over raw performance
    2. Each stem should be treated as an independent artifact and stored on disk with a deterministic naming scheme
    3. After splitting, each stem audio file must be converted to Ogg eventually to ensure Clone Hero compatibility
    4. Metadata such as stem type, duration, and sample rate should be recorded for downstream validation
3. For each stem…
    1. Pass the audio of the stem into the audio2chart model multiple times, once for each difficulty
    2. Each inference run should be isolated so that failures in one difficulty do not invalidate the others
    3. Progress updates should be surfaced to the user, including which stem and difficulty are currently being processed
4. Assemble the chart into a .chart file
    1. Convert the tokenized output of audio2chart back into time-aligned note events
    2. Insert notes into the correct instrument and difficulty tracks
    3. Populate required song metadata such as name, artist, charter, offset, and BPM
    4. Validate the final .chart structure before proceeding to packaging
5. Bundle the various stem audios and .chart file into a .sng file
    1. Ensure all audio assets are correctly referenced by the chart
    2. Apply optional metadata such as album name, year, and genre if available
    3. Compress and package the assets according to the .sng specification
6. Output the .sng to either the current directory or the Clone Hero songs directory
    1. If the Clone Hero directory is auto-detected, confirm the destination with the user
    2. If not detected, default to the current working directory and inform the user clearly

---

## Step 1: Obtaining songs

Dolly officially only supports local audio files. The supported formats are: **WAV**, **MP3**, **FLAC**, and **OGG**. Any other confirmed working formats are unsupported, as they are usually proprietary/from one vendor (ALAC, AIFF, etc.).

For direct file input, Dolly will prioritize robustness and early validation. Files will be checked for format compatibility, duration sanity, and basic decodability before any expensive processing occurs. This ensures users receive immediate feedback if the provided input is invalid.

---

## Step 2: Splitting a song into stems

We will use LALAL.ai for the stem splitting process due to its strong performance across a wide variety of genres.

The default stem set will consist of:

- drums
- bass
- guitar (electric or acoustic when available)
- vocals

Each stem will be processed independently, allowing partial success in cases where certain stems fail or are unavailable. Dolly should gracefully degrade rather than aborting the entire pipeline when one stem cannot be produced.

All stem outputs will be normalized to a consistent sample rate and channel configuration to simplify downstream processing.

Splitting typically takes a minute or two per song, however this would cost significant amounts of money/API credits to actually nail down.

---

## Step 3: Chart Generation

Chart generation is handled entirely by the audio2chart model, which maps raw audio directly to chart tokens using a Transformer-based architecture.

Each stem is passed through the model independently, allowing instrument-specific chart characteristics to emerge naturally from the training data. This also enables future expansion to additional instruments without reworking the entire pipeline.

Multiple inference passes are required to generate charts for all difficulties. These passes may be parallelized where system resources allow, but sequential execution should remain the default to avoid overwhelming user hardware.

---

## Step 4: Chart Merging

Since we are charting multiple stems (and perhaps multiple difficulties per stem), audio2chart will produce several independent .chart files. Dolly needs a parser and writer for the .chart format so it can merge these outputs into a single unified .chart file containing all instrument and difficulty tracks.

---

## Step 5: Final conversion to .sng

Once the .chart file and audio assets are finalized, Dolly will package them into a .sng archive.

This step includes:

- Converting all audio to MP3
- Ensuring consistent naming and directory structure
- Embedding optional metadata

The resulting .sng file represents the final distributable artifact produced by Dolly.

The .sng file will have the following structure:

- Song metadata (fetched by Shazam or provided by user)
- notes.chart
- Song stems

Note that the .sng is just a packed form of a standard song directory, with some extra metadata

---

## Step 6: Move the final .sng to the Clone Hero songs directory

Dolly will attempt to detect the user’s operating system and common Clone Hero installation paths. If detection succeeds, Dolly may optionally copy the file directly into the user’s songs directory, if not running in a server environment.

If detection fails, Dolly will fall back to the current working directory and clearly inform the user where the file has been placed.

Detected paths may be cached locally to improve future runs.

As an alternative to automatic detection, or if it fails completely, we can allow the user to specify a songs directory to output to.

---

# Error Handling & User Feedback

Dolly should prioritize actionable error messages over raw stack traces.

For known failure modes (API errors, unsupported formats, model failures), Dolly will:

- Explain the likely cause
- Suggest concrete steps to resolve the issue
- Provide links to documentation or issue trackers when appropriate

Unexpected errors should be logged in detail and surfaced to the user with a concise summary and next steps.

# User Flow

1. User calls program with arguments:
    1. `--file` (`-f`): Path to the audio file to be converted (optionally without `-f`, as a required argument)
    2. `--stems` : Currently a development argument to tell [LALAL.ai](http://LALAL.ai) what stems to split into. In the future, stems will be split into a hardcoded set, like guitar, drums and bass
2. Program calls [LALAL.ai](http://LALAL.ai) multiple times, once per stem to be split (takes a couple minutes)
3. (IMPLEMENT) Program uses stems returned from [LALAL.ai](http://LALAL.ai) and passes them into the (multiple?) audio2chart models to generate Easy, Medium, Hard and Expert tracks for each instrument. User is continuously updated with how much CPU/GPU usage the model is using, to maintain transparency.
4. The program states where it has dropped the completed .sng file.

---

# System Architecture

![Untitled-2026-03-12-2004.png](Untitled-2026-03-12-2004.png)

## System Components

- Frontend: User-facing website and UI.
- Stemmer API: Provides the stem splitting functionality; takes an audio file and attempts to extract specific instruments or sources from the audio.
- Neon Auth/DB: A scalable, managed PostgreSQL database and user authentication service.
- S3: Scalable object storage for user data.
- API Server: Core Dolly backend.
- GPU Server: A server with an accelerated processor for machine learning; runs the audio2chart model.
- API Gateway: API middleware; enforces IP-based rate limiting, authentication, and more. Internally interfaces with the various components of the API server.
- Storage Manager: A high-level middleware for S3.
- Task: One step of the conversion process, could be any of the following (can and will change): Split stems, run audio2chart, upload to S3. Has a unique UUID
- Slot: A state machine and allocable resource for managing/executing a single task. A slot can have capabilities, and based on those capabilities may only be able to handle certain kinds of tasks
- Task Queue: A scalable queue for user tasks that manages task state.
- Task Manager: Takes user requests and dynamically allocates slots for user tasks.

---

# Difficulty Generator

Currently, Dolly only generates Expert-difficulty charts. Multi-difficulty support is a future goal.

**Potential approaches (not yet implemented):**

1. **Per-difficulty model training** — Train separate models for each difficulty on collected data for Hard, Medium, and Easy charts.
2. **Note removal from Expert** — Generate the Expert chart, then programmatically thin notes for lower difficulties (e.g., Hard: remove 25%, Medium: 50%, Easy: 75% + restrict to 3 lanes).

---

# Public Functions

> **Base URL:** `https://api.dolly.example.com/v1`
> 
> 
> All requests pass through the **API Gateway**, which enforces IP-based rate limiting, authentication (via Neon Auth), and request validation before routing to internal services.
> 

---

## Authentication

Every request must include a valid bearer token issued by Neon Auth.

```
Authorization: Bearer <token>
```

### `POST /auth/register`

Create a new user account.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | string | Yes | User email address |
| `password` | string | Yes | Minimum 8 characters |
| `display_name` | string | No | Display name for the account |

**Response** `201 Created`

```json
{
  "user_id": "usr_a1b2c3d4",
  "email": "user@example.com",
  "created_at": "2026-03-13T12:00:00Z"
}
```

---

### `POST /auth/login`

Authenticate and receive a session token.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | string | Yes | Registered email |
| `password` | string | Yes | Account password (transmitted over TLS; the server is responsible for hashing with bcrypt before storage) |

**Response** `200 OK`

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-03-14T12:00:00Z",
  "user_id": "usr_a1b2c3d4"
}
```

---

### `POST /auth/logout`

Invalidate the current session token.

**Response** `204 No Content`

---

## Files

File endpoints are handled by the **Storage Manager**, which acts as a high-level middleware for S3 object storage. All audio files and generated outputs are stored in S3 (or a service with an identical API, such as MinIO).

### `POST /files/upload`

Upload an audio file to S3 for processing.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `file` | binary (multipart) | Yes | Audio file (`wav`, `mp3`, `flac`, `ogg`) |
| `name` | string | Yes | The filename to use. On the frontend this should default to whatever the uploaded file’s existing name is |

**Response** `201 Created`

```json
{
  "file_id": "file_7f8e9d0c",
  "name": "track.wav",
  "size_bytes": 10485760,
  "mime_type": "audio/wav",
  "created_at": "2026-03-13T12:05:00Z"
}
```

**Errors**

| Code | Reason |
| --- | --- |
| `413` | File exceeds the maximum allowed size |
| `415` | Unsupported audio format |
| `429` | Rate limit exceeded |

---

### `GET /files/{file_id}`

Retrieve metadata for a specific file.

**Response** `200 OK`

```json
{
  "file_id": "file_7f8e9d0c",
  "name": "track.wav",
  "size_bytes": 10485760,
  "mime_type": "audio/wav",
  "created_at": "2026-03-13T12:05:00Z",
  "download_url": "https://cdn.dolly.example.com/files/file_7f8e9d0c?token=..."
}
```

---

### `GET /files/{file_id}/download`

Download the file content. Returns a **pre-signed S3 URL** redirect or streams the file directly, depending on file size.

**Response** `302 Found` or `200 OK` (streamed)

---

### `GET /files`

List all files belonging to the authenticated user.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `page` | int | `1` | Page number |
| `per_page` | int | `20` | Results per page (max 100) |
| `sort` | string | `created_at` | Sort field (`created_at`, `name`, `size_bytes`) |
| `order` | string | `desc` | Sort direction (`asc` / `desc`) |

**Response** `200 OK`

```json
{
  "files": [ { "file_id": "...", "name": "...", "..." : "..." } ],
  "total": 42,
  "page": 1,
  "per_page": 20
}
```

---

### `DELETE /files/{file_id}`

Permanently delete a file from S3. If the file is referenced by an in-progress task, the request will fail.

**Response** `204 No Content`

**Errors**

| Code | Reason |
| --- | --- |
| `404` | File not found |
| `409` | File is in use by an active task |

---

## Tasks

A **task** represents a single step in the audio conversion pipeline. Tasks are managed by the **Task Manager**, which dynamically allocates **Slots** from the **Task Queue** to execute work. Each slot is a state machine that runs exactly one task at a time and may have capabilities limiting which task types it can handle.

### Task Types

| Type | Description | Runs On |
| --- | --- | --- |
| `split_stems` | Use the Stemmer API to separate an audio file into individual instrument/source stems | Stemmer API |
| `audio2chart` | Run the audio2chart ML model to convert audio into chart data | GPU Server |
| `upload_s3` | Upload a processing result to S3 for user download | Storage Manager → S3 |

### Task Lifecycle

```
pending → queued → assigned → processing → completed
                                        ↘ failed
```

| State | Description |
| --- | --- |
| `pending` | Task created; waiting for the Task Manager to evaluate it |
| `queued` | Task is in the Task Queue waiting for an available slot |
| `assigned` | A slot with matching capabilities has been allocated |
| `processing` | The slot is actively executing the task on its target service |
| `completed` | Task finished successfully; output is available |
| `failed` | Task encountered an error; see `error` field for details |

---

### `POST /tasks`

Create a new task in the pipeline.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | Yes | Task type (`split_stems`, `audio2chart`, `upload_s3`) |
| `input_file_id` | string | Yes | The file ID to process |
| `settings` | object | No | Type-specific settings (see Settings by Task Type below) |

**Response** `201 Created`

```json
{
  "task_id": "task_e4f5a6b7-89c0-11ee-b9d1-0242ac120002",
  "type": "split_stems",
  "status": "pending",
  "progress": 0.0,
  "input_file_id": "file_7f8e9d0c",
  "settings": { "stems": 4, "model": "orion" },
  "created_at": "2026-03-13T12:10:00Z"
}
```

**Errors**

| Code | Reason |
| --- | --- |
| `400` | Invalid task type or settings |
| `404` | Input file not found |
| `429` | Rate limit exceeded |

---

### `GET /tasks/{task_id}`

Check the current status and details of a task.

**Response** `200 OK`

```json
{
  "task_id": "task_e4f5a6b7-89c0-11ee-b9d1-0242ac120002",
  "type": "audio2chart",
  "status": "processing",
  "progress": 0.65,
  "slot_id": "slot_03",
  "input_file_id": "file_7f8e9d0c",
  "settings": { "difficulty": "expert", "instrument": "guitar" },
  "created_at": "2026-03-13T12:10:00Z",
  "started_at": "2026-03-13T12:10:04Z",
  "completed_at": null,
  "output_file_id": null,
  "error": null
}
```

When `status` is `completed`:

```json
{
  "task_id": "task_e4f5a6b7-89c0-11ee-b9d1-0242ac120002",
  "type": "audio2chart",
  "status": "completed",
  "progress": 1.0,
  "slot_id": "slot_03",
  "input_file_id": "file_7f8e9d0c",
  "settings": { "difficulty": "expert", "instrument": "guitar" },
  "created_at": "2026-03-13T12:10:00Z",
  "started_at": "2026-03-13T12:10:04Z",
  "completed_at": "2026-03-13T12:12:38Z",
  "output_file_id": "file_b2c3d4e5",
  "error": null
}
```

When `status` is `failed`:

```json
{
  "...": "...",
  "status": "failed",
  "error": {
    "code": "GPU_TIMEOUT",
    "message": "The GPU server did not respond within the allotted time."
  }
}
```

---

### `GET /tasks`

List all tasks for the authenticated user.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `status` | string | — | Filter by status (`pending`, `queued`, `assigned`, `processing`, `completed`, `failed`) |
| `type` | string | — | Filter by task type |
| `page` | int | `1` | Page number |
| `per_page` | int | `20` | Results per page (max 100) |

**Response** `200 OK`

```json
{
  "tasks": [ { "task_id": "...", "status": "...", "..." : "..." } ],
  "total": 7,
  "page": 1,
  "per_page": 20
}
```

---

### `DELETE /tasks/{task_id}`

Cancel a pending or queued task owned by this authenticated user. Tasks that are already `processing`, `completed`, or `failed` cannot be cancelled.

**Response** `204 No Content`

**Errors**

| Code | Reason |
| --- | --- |
| `404` | Task not found |
| `409` | Task is already processing or has finished and cannot be cancelled |

---

## Conversions

A **conversion** is a high-level orchestration that chains the full pipeline (`split_stems` → `audio2chart` per stem → `upload_s3`) into a single request. The server creates and sequences the underlying tasks automatically.

### `POST /conversions`

Start a full song-to-chart conversion.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input_file_id` | string | Yes | The uploaded audio file to convert |
| `instruments` | string[] | No | Instruments to chart (default: `["guitar", "bass", "drums"]`) |
| `difficulty` | string | No | Target difficulty (default: `"expert"`) |

**Response** `201 Created`

```json
{
  "conversion_id": "conv_a1b2c3d4",
  "status": "in_progress",
  "input_file_id": "file_7f8e9d0c",
  "tasks": [
    { "task_id": "task_001", "type": "split_stems", "status": "pending" },
    { "task_id": "task_002", "type": "audio2chart", "status": "pending" },
    { "task_id": "task_003", "type": "audio2chart", "status": "pending" },
    { "task_id": "task_004", "type": "audio2chart", "status": "pending" },
    { "task_id": "task_005", "type": "upload_s3", "status": "pending" }
  ],
  "created_at": "2026-03-13T12:10:00Z"
}
```

### `GET /conversions/{conversion_id}`

Check the status of a conversion and all its constituent tasks.

### `GET /conversions`

List all conversions for the authenticated user. Supports the same pagination parameters as `GET /tasks`.

---

## Slots (Admin / Internal)

These endpoints are used internally by the Task Manager and are not exposed to end users. They are documented here for completeness.

### `GET /internal/slots`

List all slots and their current state.

**Response** `200 OK`

```json
{
  "slots": [
    {
      "slot_id": "slot_01",
      "status": "busy",
      "capabilities": ["split_stems", "upload_s3"],
      "current_task_id": "task_e4f5a6b7-89c0-11ee-b9d1-0242ac120002",
      "gpu_server": null
    },
    {
      "slot_id": "slot_02",
      "status": "idle",
      "capabilities": ["audio2chart"],
      "current_task_id": null,
      "gpu_server": "gpu-03.internal"
    }
  ]
}
```

### `POST /internal/slots/{slot_id}/assign`

Assign a task to a specific slot.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `task_id` | string | Yes | The task UUID to assign |

**Response** `200 OK`

### `POST /internal/slots/{slot_id}/release`

Release a slot after task completion or failure, making it available for new work.

**Response** `200 OK`

---

## Internal Function Signatures

The sections below describe the internal functions called by each endpoint and service layer. These are not HTTP endpoints — they are the in-process or RPC-level calls that the API Server components use to fulfill user requests.

---

### API Gateway

Functions executed by the gateway middleware before a request reaches any route handler.

```
gateway.authenticateRequest(token: string) → AuthContext | AuthError
```

Validates the bearer token against Neon Auth. Returns an `AuthContext` containing the resolved `user_id`, token expiry, and permission scopes, or an `AuthError` if the token is missing, expired, or revoked.

```
gateway.enforceRateLimit(ip: string, route: string) → RateLimitResult
```

Checks the request's source IP against the per-route rate limit window. Returns the current `remaining` count and `reset` timestamp. Throws `RateLimitExceeded` if the window is exhausted.

```
gateway.validateRequestBody(schema: SchemaDefinition, body: object) → ValidatedBody | ValidationError
```

Validates and coerces the incoming JSON body against the expected schema for the matched route. Returns sanitised input or a `ValidationError` with per-field details.

```
gateway.resolveRoute(method: string, path: string) → RouteHandler
```

Matches the HTTP method and path to an internal route handler, injecting the `AuthContext` and validated body into the handler's arguments.

---

### Neon Auth

Functions provided by the managed Neon Auth / DB service for user identity.

```
neonAuth.createUser(email: string, passwordHash: string, displayName?: string) → UserRecord
```

Inserts a new user row into the Neon PostgreSQL `users` table. Returns the created `UserRecord` including the generated `user_id`. Throws `DuplicateEmail` if the address is already registered.

```
neonAuth.verifyCredentials(email: string, password: string) → UserRecord | null
```

Looks up the user by email and compares the supplied password against the stored hash. Returns the `UserRecord` on success or `null` on mismatch.

```
neonAuth.issueToken(userId: string) → TokenPair
```

Generates a signed JWT access token and an opaque refresh token, persists the session in the database, and returns both along with `expires_at`.

```
neonAuth.revokeToken(token: string) → void
```

Marks the session associated with the given token as revoked, preventing any further use.

```
neonAuth.validateToken(token: string) → AuthContext | null
```

Decodes and verifies the JWT signature and expiry. Returns the `AuthContext` (user ID, scopes, expiry) or `null` if the token is invalid or revoked. Called internally by `gateway.authenticateRequest`.

---

### Storage Manager

High-level middleware that wraps S3 operations and manages file metadata in the database.

```
storageManager.putObject(userId: string, stream: ReadableStream, metadata: FileMetadata) → FileRecord
```

Generates a unique `file_id`, streams the data to the S3 bucket under a namespaced key (`users/{userId}/{fileId}`), writes the metadata row to the database, and returns the completed `FileRecord`.

```
storageManager.getObjectMetadata(fileId: string, userId: string) → FileRecord | null
```

Queries the database for the file metadata row. Returns `null` if the file doesn't exist or doesn't belong to the requesting user.

```
storageManager.generatePresignedUrl(fileId: string, expiresIn: number) → string
```

Calls S3's `presignGetObject` to produce a time-limited download URL for the given file key. `expiresIn` is in seconds.

```
storageManager.streamObject(fileId: string) → ReadableStream
```

Opens a direct streaming read from S3 for the file. Used for smaller files where a redirect to a pre-signed URL is unnecessary.

```
storageManager.deleteObject(fileId: string, userId: string) → void
```

Deletes the object from S3 and removes the metadata row from the database. Throws `FileInUse` if any active task references this file.

```
storageManager.listObjects(userId: string, options: PaginationOptions) → PaginatedList<FileRecord>
```

Queries the database for all file metadata rows belonging to the user, with pagination, sorting, and ordering applied.

```
storageManager.checkFileInUse(fileId: string) → boolean
```

Queries the task table to determine whether any non-terminal task (`pending`, `queued`, `assigned`, `processing`) references the given `fileId` as its input or output.

---

### Task Manager

Orchestration layer that accepts user task requests, manages the Task Queue, and allocates Slots.

```
taskManager.createTask(userId: string, type: TaskType, inputFileId: string, settings: TaskSettings) → TaskRecord
```

Validates that `inputFileId` exists and belongs to the user, creates a `TaskRecord` with status `pending` and a generated UUID, inserts it into the Task Queue, and kicks off slot allocation via `taskManager.scheduleTask`.

### Settings by Task Type

**`split_stems`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `stems` | int | `4` | Number of stems to extract (2, 4, or 5) |
| `model` | string | `"orion"` | LALAL.ai processing model variant |

**`audio2chart`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `difficulty` | string | `"expert"` | Target chart difficulty |
| `instrument` | string | `"guitar"` | Target instrument for charting |

**`upload_s3`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `source_task_id` | string | — | The task whose output should be uploaded |

```
taskManager.scheduleTask(taskId: string) → void
```

Moves the task from `pending` to `queued`, then scans the slot pool for an idle slot whose capabilities include the task's type. If a slot is available, calls `taskManager.assignSlot`; otherwise the task remains `queued` until a slot is released.

```
taskManager.assignSlot(taskId: string, slotId: string) → void
```

Transitions the task to `assigned`, marks the slot as `busy`, binds the task to the slot, and calls `slot.execute` to begin processing.

```
taskManager.onTaskComplete(taskId: string, result: TaskResult) → void
```

Callback invoked by a slot when execution finishes. Updates the task to `completed`, writes the `output_file_id`, releases the slot via `taskManager.releaseSlot`, and triggers scheduling for any queued tasks.

```
taskManager.onTaskFailed(taskId: string, error: TaskError) → void
```

Callback invoked by a slot when execution fails. Updates the task to `failed` with the error details, releases the slot, and triggers scheduling for any queued tasks.

```
taskManager.releaseSlot(slotId: string) → void
```

Marks the slot as `idle`, clears its current task binding, and calls `taskManager.drainQueue` to check for waiting tasks.

```
taskManager.drainQueue() → void
```

Iterates over all `queued` tasks in priority order and attempts to match each to an available slot. Stops when no more idle slots with matching capabilities remain.

```
taskManager.cancelTask(taskId: string, userId: string) → void
```

Cancels a task if its status is `pending` or `queued`. Removes it from the queue and sets status to `cancelled`. Throws `TaskNotCancellable` if the task is already `processing` or terminal.

```
taskManager.getTask(taskId: string, userId: string) → TaskRecord | null
```

Retrieves a task by ID, scoped to the requesting user.

```
taskManager.listTasks(userId: string, filters: TaskFilters, options: PaginationOptions) → PaginatedList<TaskRecord>
```

Lists all tasks for a user with optional status and type filters, paginated.

---

### Slot

Each slot is a state machine and allocable resource. A slot has a fixed set of capabilities and executes exactly one task at a time by dispatching to the appropriate task executor.

```
slot.execute(task: TaskRecord) → void
```

Entry point called by the Task Manager after assignment. Transitions the slot's internal state to `executing`, resolves the correct executor for the task type, and calls it. On completion or failure, invokes the appropriate Task Manager callback.

```
slot.resolveExecutor(type: TaskType) → TaskExecutor
```

Maps a `TaskType` to the concrete executor function: `split_stems` → `stemmerExecutor`, `audio2chart` → `audio2chartExecutor`, `upload_s3` → `uploadS3Executor`. Throws `UnsupportedTaskType` if the slot lacks the required capability.

```
slot.reportProgress(taskId: string, progress: number) → void
```

Updates the task's `progress` field (0.0–1.0) in the database. Called periodically by executors to surface incremental progress to the user.

```
slot.getState() → SlotState
```

Returns the slot's current state: `idle`, `executing`, or `draining` (finishing up before shutdown).

```
slot.getCapabilities() → TaskType[]
```

Returns the list of task types this slot can handle, determined at slot registration time based on available resources (e.g., a slot bound to a GPU server has the `audio2chart` capability).

---

### Task Executors

Concrete functions that perform the actual work for each task type. Each executor is invoked by a Slot and communicates results back through the slot's callbacks.

### `split_stems` Executor (Stemmer API)

```
stemmerExecutor.run(task: TaskRecord, slot: Slot) → TaskResult
```

Top-level executor for stem splitting. Orchestrates the calls below in sequence: download → split → collect → return.

```
stemmerExecutor.downloadInput(fileId: string) → LocalFilePath
```

Pulls the source audio file from S3 via the Storage Manager into a local temporary path for submission to the Stemmer API.

```
stemmerExecutor.requestSplit(filePath: LocalFilePath, model: string, stemCount: number) → StemmerJobId
```

Submits the audio file to the Stemmer API with the requested model and stem count. Returns the Stemmer API's job identifier for polling.

```
stemmerExecutor.pollStemmerJob(jobId: StemmerJobId, slot: Slot) → StemmerResult
```

Polls the Stemmer API for job completion, calling `slot.reportProgress` on each poll cycle. Returns the `StemmerResult` containing download URLs for each separated stem once the job finishes. Throws `StemmerTimeout` or `StemmerError` on failure.

```
stemmerExecutor.collectStems(result: StemmerResult, userId: string) → FileRecord[]
```

Downloads each separated stem from the Stemmer API's output URLs and uploads them to S3 via `storageManager.putObject`. Returns an array of `FileRecord` entries, one per stem.

---

### `audio2chart` Executor (GPU Server)

```
audio2chartExecutor.run(task: TaskRecord, slot: Slot) → TaskResult
```

Top-level executor for the audio-to-chart ML pipeline. Orchestrates: download → preprocess → infer → postprocess → return.

```
audio2chartExecutor.downloadInput(fileId: string) → LocalFilePath
```

Pulls the source audio file from S3 via the Storage Manager into a local temporary path on the GPU server.

```
audio2chartExecutor.preprocessAudio(filePath: LocalFilePath, settings: Audio2ChartSettings) → TensorPayload
```

Decodes the audio file, resamples to the model's expected sample rate, extracts spectral features, and packages them into a `TensorPayload` ready for inference. The `instrument` and `difficulty` settings may influence feature extraction (e.g., frequency band emphasis).

```
audio2chartExecutor.runInference(payload: TensorPayload, gpuServer: GPUServerAddress) → RawModelOutput
```

Sends the tensor payload to the designated GPU server, which runs the `audio2chart` model. Returns the raw model output (note onset predictions, timing data, confidence scores). Calls `slot.reportProgress` based on batch completion. Throws `GPUTimeout` if the server doesn't respond within the configured deadline.

```
audio2chartExecutor.postprocessChart(raw: RawModelOutput, settings: Audio2ChartSettings) → ChartData
```

Converts raw model output into a structured `ChartData` object: quantises note timings to the nearest valid subdivision, filters by the requested difficulty level, maps predicted onsets to the target instrument's note lanes, and validates the chart for structural integrity.

```
audio2chartExecutor.serializeChart(chart: ChartData, format: string) → Buffer
```

Serialises the `ChartData` into the target output format (e.g., `.chart`, `.mid`, JSON). Returns a byte buffer ready for upload.

---

### `upload_s3` Executor (Storage Manager)

```
uploadS3Executor.run(task: TaskRecord, slot: Slot) → TaskResult
```

Top-level executor for uploading a prior task's output to S3 for user download.

```
uploadS3Executor.resolveSourceOutput(sourceTaskId: string, userId: string) → LocalFilePath | FileRecord
```

Looks up the source task by ID, verifies it belongs to the same user and is `completed`, and resolves its output — either a reference to an already-uploaded `FileRecord` or a local path to a temporary artifact that hasn't been persisted yet.

```
uploadS3Executor.uploadToStorage(source: LocalFilePath | Buffer, userId: string, metadata: FileMetadata) → FileRecord
```

Streams the resolved output to S3 via `storageManager.putObject`, attaching the appropriate metadata (MIME type, original task reference, file name). Returns the new `FileRecord` with its `file_id` and download URL.

```
uploadS3Executor.linkOutputToTask(taskId: string, fileRecord: FileRecord) → void
```

Updates the originating task's `output_file_id` to point to the newly created file, making it discoverable via `GET /tasks/{task_id}`.

---

### Database Helpers (Neon PostgreSQL)

Low-level data access functions used across services.

```
db.query<T>(sql: string, params: any[]) → T[]
```

Executes a parameterised SQL query against the Neon PostgreSQL connection pool. Returns typed result rows.

```
db.transaction<T>(fn: (tx: Transaction) → T) → T
```

Wraps a set of operations in a database transaction, automatically committing on success or rolling back on error.

```
db.users.findById(userId: string) → UserRecord | null
```

Retrieves a user row by primary key.

```
db.files.insert(record: FileRecord) → FileRecord
```

Inserts a new file metadata row.

```
db.files.findByUser(userId: string, options: PaginationOptions) → PaginatedList<FileRecord>
```

Queries file rows for a given user with pagination.

```
db.files.delete(fileId: string) → void
```

Removes a file metadata row by ID.

```
db.tasks.insert(record: TaskRecord) → TaskRecord
```

Inserts a new task row with status `pending`.

```
db.tasks.updateStatus(taskId: string, status: TaskStatus, fields?: Partial<TaskRecord>) → void
```

Atomically updates a task's status and any additional fields (e.g., `started_at`, `completed_at`, `output_file_id`, `error`).

```
db.tasks.findByUser(userId: string, filters: TaskFilters, options: PaginationOptions) → PaginatedList<TaskRecord>
```

Queries task rows for a given user, with optional status/type filters and pagination.

```
db.tasks.findActiveByFileId(fileId: string) → TaskRecord[]
```

Returns all non-terminal tasks that reference the given `fileId`, used by `storageManager.checkFileInUse`.

---

## Rate Limiting

The API Gateway enforces rate limits at two levels: **per-IP** (to prevent abuse from unauthenticated endpoints) and **per-user** (to fairly distribute resources among authenticated users). When a limit is exceeded, the response includes:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1710331200
```

| Header | Description |
| --- | --- |
| `X-RateLimit-Limit` | Maximum requests per window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |
| `Retry-After` | Seconds to wait before retrying |

---

## Common Error Format

All error responses follow a consistent structure:

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "You have exceeded the maximum number of requests. Please try again later.",
    "details": {}
  }
}
```

| Code | HTTP Status | Description |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | Missing or invalid auth token |
| `FORBIDDEN` | 403 | Authenticated but lacking permission |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Action conflicts with current resource state |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `UNSUPPORTED_FORMAT` | 415 | File format not accepted |
| `FILE_TOO_LARGE` | 413 | Upload exceeds size limit |
| `GPU_TIMEOUT` | 504 | GPU server did not respond in time |
| `STEMMER_ERROR` | 502 | Stemmer API returned an error |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

# Data Architecture

## Splitter functionality

`split.ts`  defines a base splitter architecture that allows for future, possibly better splitters to be added with ease:

```jsx
/** A single stem result containing the stem type and its output path. */
export interface StemResult<S extends string = string> {
    stem: S;
    path: string;
}

/** The result of a split operation. */
export interface SplitResult<S extends string = string> {
    /** The original audio file that was split. */
    sourcePath: string;
    /** The stems that were produced. */
    stems: StemResult<S>[];
}

/** Base interface that any stem splitter must implement. */
export interface StemSplitter<S extends string = string> {
    /** Human-readable name of the splitter backend. */
    readonly name: string;

    /** Returns the set of stems this backend supports. */
    supportedStems(): S[];

    /**
     * Split an audio file into the requested stems.
     *
     * @param audioPath - Path to the source audio file.
     * @param stems     - Which stems to extract. Every entry must be in
     *                    {@link supportedStems}.
     * @returns The split result containing paths to each produced stem file.
     */
    split(audioPath: string, stems: S[]): Promise<SplitResult<S>>;
```

## 

---

# High Level Tests

## [LALAL.ai](http://LALAL.ai) Tests

Find songs from each preferred genre and pass them through the stem splitter. Determine if stem quality is acceptable.

## audio2chart Tests

Pass stems or full songs into model. Determine if outputted chart is acceptable, and has a difficulty matching the difficulty chosen.

---

# Quality Metrics

1. Stem cache hits
2. Errors in each module
3. Input audio length
4. stemmer api process duration
5. audio2chart process duration

---

# Risks

## Personal Risks

1. Procrastination due to mental condition, leading to stalled progress
2. Burnout from cumulative workload across multiple projects
3. Hardware failure resulting in temporary inability to continue development
4. Physical injury or health issues interrupting development

Mitigation strategies include frequent commits, incremental milestones, and aggressive scoping of features.

## Project Risks

1. Core assumptions about model performance proving invalid in practice
2. External service dependency failures (API downtime, pricing changes)
3. Data scarcity for training lower-difficulty models
4. Simultaneous loss of local data and remote repositories

Regular backups, abstraction layers, and early prototyping reduce the impact of these risks.