# Architecture

Main layers:
1. Reddit collection
2. SQLite persistence
3. sentiment generation
4. API exposure
5. scheduled execution

Rules:
1. keep the collector readable
2. keep data flow explicit
3. avoid hidden coupling to the frontend
