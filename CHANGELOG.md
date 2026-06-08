# Changelog

All notable changes to this project will be documented here.

This project follows semantic versioning once a stable public API exists. Until then, `0.x` releases may contain breaking protocol, CLI, or deployment changes when required for security or interoperability.

## 0.1.0 - 2026-06-06

Initial public beta candidate.

- Added CLI sender and receiver as `ff`.
- Added static browser sender and receiver.
- Added the `ff-server` WebSocket signaling server with in-memory rendezvous state.
- Added CPace PAKE, confirmation tags, authenticated SDP/ICE signaling, and DataChannel AEAD.
- Added receiver consent gate, redacted server-visible manifests, chunked transfer, SHA-256 verification, backpressure, and resume support.
- Added production origin policy checks, browser asset SRI plus server-side SHA-256 manifest verification, optional TURN REST credentials, Docker runtime policy, CI gates, packed install smoke, browser/CLI interop tests, and release artifact verification.
