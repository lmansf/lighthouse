# How Lighthouse is put together

## What Lighthouse is

Lighthouse is an app that helps people ask questions about their own files and spreadsheets.

Most of the app runs on the person's own computer, instead of sending their files away.

The app has a screen people can see, a strong worker that does the hard jobs, and clear rules for how the pieces talk.

There is also a practice version for programmers to use while they make the screen.

## The big parts

| Part | Where it lives | What it does | Why that helps |
| --- | --- | --- | --- |
| Screen | `app/`, `src/features/`, `src/shell/` | Shows buttons, words, and answers. | The screen can stay simple while other parts do hard work. |
| Rules | `src/contracts/` | Says how parts are allowed to talk to each other. | Parts do not get mixed up. |
| Messenger | `src/contracts/real/ragTransport.ts`, `src/shell/tauriTransport.ts` | Carries messages between the screen and the worker. | There is one safe place for packing and unpacking messages. |
| Main worker | `native/crates/lighthouse-core/` | Reads files, finds answers, checks numbers, and protects saved information. | Important work happens in one careful place. |
| Desktop helper | `native/crates/lighthouse-shell/`, `native/crates/lighthouse-desktop/` | Opens windows, uses the tray, and talks to the computer. | Computer-specific jobs do not make the main worker messy. |
| Practice worker | `src/server/`, `app/api/` | Helps programmers test the screen in a browser. | Programmers can work quickly without pretending it can do every desktop job. |

## Big choices and why they are good

### Clear rules before new parts

Different screen parts use shared rules, such as `RagService` and `ChatService`, instead of reaching inside each other.

This helps because one part can change without breaking all the others.

### One main worker

The Rust worker takes care of saving things, reading files, finding useful pieces, and checking facts.

This helps because there is one careful source of truth.

### A safe practice version

The browser practice version copies only the jobs it can really do and says “not here” for the others.

This helps because it never makes up an answer just to look helpful.

### Your files stay close to you

Your files, choices, and history stay on your own computer.

If information ever leaves the computer, the app keeps track of why it left.

This helps people trust what happens to their things.

### Small answer helpers

Small helpers answer one small question, like “should we try again?” or “should this be shown?”

This helps because they are easy to test and less likely to surprise people.

### Checked facts before stories

The worker checks number facts before the writing helper talks about them.

This helps because a nice-sounding answer should not trick someone with made-up numbers.

## How a new version gets to people

Before a new version goes out, computers run many checks.

The release process builds the app, checks that its important pieces are inside, and sends a good iPhone build to TestFlight.

This helps because the exact app people receive gets checked, not just the loose pieces on a programmer's computer.
