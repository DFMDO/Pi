// Mini-Server für den Richtlinien-Test: antwortet auf 127.0.0.1:8080 und :8081 mit einer Textseite (läuft nur lokal).
import http from 'node:http';
for (const port of [8080, 8081]) http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(`<h1 style="font:40px sans-serif">OK – Seite geladen (Port ${port}, ${q.url})</h1>`); }).listen(port, '127.0.0.1');
console.log('Test-Server läuft auf 127.0.0.1:8080 und :8081');
