# Poliana multijugador

## Correrlo
1. Abre esta carpeta en Visual Studio Code (Archivo > Abrir carpeta).
2. Abre la terminal (Ctrl + ñ) y corre:
   npm install
   npm start
3. Entra a http://localhost:3000, crea una sala y comparte el link.

Necesitas Node.js 18 o más nuevo (https://nodejs.org).

## Jugar con amigos
- Misma red Wi-Fi: pásales http://TU-IP-LOCAL:3000 (en Windows, corre `ipconfig` y busca IPv4).
- Por internet: en otra terminal corre `npx cloudflared tunnel --url http://localhost:3000` (o `npx ngrok http 3000`) y comparte el link https que te dé.
- Para dejarlo siempre en línea: súbelo a Render o Railway (comando de inicio: npm start).

## Cómo está armado
- server.js: salas, turnos y reglas. Valida todas las jugadas, así nadie puede hacer trampa.
- public/index.html: tablero y pantallas. Solo muestra lo que manda el servidor.
