# Technical reference

This is a map of how Lighthouse works.

The first pages explain the big ideas in simple words.

The other pages are big lists of the small jobs that make the app work.

- [Architecture](architecture.md) explains the big parts of Lighthouse and why they are useful.
- [Scripts](scripts.md) explains each helper script and why it is useful.
- [Functions](functions.md) lists the code jobs and gives each one a simple clue.
- [Methods](methods.md) lists jobs that belong to a particular kind of thing in the Rust engine.

Programmers run `node scripts/generate-reference.mjs` after changing the list of code jobs.

The computer can run `node scripts/generate-reference.mjs --check` to make sure the list is not old.
