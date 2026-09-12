# Agent Note: Drop or paste a file into the session's working directory

Status: implemented

English | [中文](2026-08-23-composer-file-drop-into-working-directory.zh.md)

## Problem

The Web composer could take images and nothing else: a dropped or pasted file went down the draft rail's path, where every non-image MIME was refused with the image-format copy. Handing a session any other file — a PDF to review, a CSV to analyze, a failing script — had no composer path at all. The user had to copy it into the project themselves, run a shell command, or describe it well enough for the agent to reconstruct. Meanwhile the browser held the file, and the session's own tools, which read the project directory, could not see it.

## Decision

The composer writes dropped and pasted non-image files into the addressed session's working directory through `POST /api/workspace-file?session=<id>&name=<name>`, registered by the web-app bundle beside the fork's `/api/ocr` route. The route answers `{ name, path, bytes }`, where `path` is relative to the session's directory, and the composer appends one mention line naming those paths to the draft — `📎 Ajouté au répertoire de travail : docs/notes.txt` in French — so the agent reads the file with its own tools instead of being told about it in prose. The user sends the message when it is ready.

The session id is the only authority a request carries. The directory comes from the host-resident session header (`ctx.sessions.get(id)?.header.cwd`), never from the client, and `name` must be one path component — a separator, `.`, or `..` is refused with 400 before any write. The route therefore cannot address anything outside the session's own project. An existing file is never replaced: `notes.txt` becomes `notes-1.txt` when the name is taken (up to 100 candidates), and the response carries the name actually written.

Images keep the draft rail and its own validation; every other file takes the write path. One split in the composer serves both gestures that can carry files — a document drop (routed by the attachment plugin through the slot's `onAddFiles`) and a clipboard paste — so the two cannot diverge. The drop invitation switches to the file wording while the composer takes files (`file.dropTitle` / `file.dropDesc`).

The route bounds a request at 64 MiB of body and 255 bytes of name, and answers 404 for an unknown session, 409 for a session whose header carries no cwd (a pre-project log), and 405 for a non-POST method.

## Alternatives considered

**Carry the file on the image attachment channel** (base64 in the submit payload, which is how images reach the host). The attachment store is image-only by contract, and the goal is a file in the project the session's tools already read — not a blob in the browser's attachment space. Extending that channel would also have changed the submit wire format and the logged user message for a use case that needs neither.

**Add a generated RPC method to the API domain surface.** The typed RPC map is the harness-native path and would give end-to-end types. It costs a schema, codegen, and a rebuild of the generated client contracts for a fork-local surface that the `/api/ocr` precedent already covers with a plain route, which is why this ships as a route.

**Auto-submit the message after the write.** Handing the file over and sending in one gesture is fewer clicks, but it takes the prompt away from the user: the mention is the whole message, and any instruction ("résume ce PDF") must then be a second turn. The mention lands in the draft instead, and one Enter sends both.

**Ask for a target directory on each upload.** A picker makes the destination explicit. It also asks a question the session has already answered — its working directory is the only root its tools are scoped to — and a client-supplied path would move the authority for what may be written where from the host to the browser.

## Consequences

A user hands the agent a file by dragging it onto the page or pasting it from the file manager; the agent finds it at the path named in the message, and the user's own editor sees the same file. The write is bounded and cannot escape the session directory, and the session id remains the only thing a request asserts.

Nothing model-visible is logged for the write itself: the file appears on disk, and the mention inside the user's message is what the model reads — the same text a user could have typed by hand. A file written by mistake is an ordinary file: the session's tools can delete or overwrite it, and the route's suffix rule means a repeat upload never destroys the earlier one.

The route trusts the same loopback/LAN boundary as every other `/api` surface of this bundle; exposing the Web GUI beyond that boundary hands file writes into session projects to whoever reaches the port, exactly as `/api/ocr` already hands them OCR calls.
