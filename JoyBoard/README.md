# JoyBoard — Render + PostgreSQL

JoyBoard is a WhatsApp-style real-time private chat application.

## Stack
- HTML, CSS, JavaScript
- Node.js + Express
- PostgreSQL
- Socket.IO
- JWT authentication
- bcrypt password hashing

## Deploy on Render
1. Put this project in a GitHub repository.
2. In Render choose New > Blueprint and connect the repository.
3. Render reads `render.yaml` and creates the web service and PostgreSQL database.
4. Deploy.
5. Open the generated `onrender.com` URL.

Render web services support WebSockets, which JoyBoard uses for real-time chat.

## Important
The free Render Postgres plan currently expires after 30 days according to Render's service documentation. Check Render's current pricing/limits before relying on it for permanent production data.

For production, keep `JWT_SECRET` as a strong private environment variable and use the database connection string supplied by Render.

## Features
- Register/login
- Protected chat area
- User search
- Private one-to-one conversations
- Real-time messages
- Online/offline presence
- Typing indicator
- Sent/read indicators
- Unread counts
- Responsive WhatsApp-style layout
- PostgreSQL message persistence
