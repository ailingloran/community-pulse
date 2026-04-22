# CLAUDE.md

## Project summary
This repository collects Reddit data for World of Warships and produces AI assisted community pulse outputs for the admin dashboard.

## Main goals
Keep collection reliable, storage simple, and API behavior stable.

## Tech stack
TypeScript
Node.js
Express
better-sqlite3
node-cron
OpenAI

## Rules for changes
1. prefer small changes
2. keep API shapes stable unless asked otherwise
3. do not overcomplicate the collector flow
4. protect database compatibility
5. keep polling logic readable
6. document new env variables and endpoints

## Debug order
1. polling and scheduler
2. Reddit fetch logic
3. database writes
4. sentiment pipeline
5. API routes
