const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());

async function proxy(req, res, endpoint) {
  try {
    const url =
      `https://lrclib.net/api/${endpoint}?` +
      new URLSearchParams(req.query).toString();

    const r = await fetch(url);

    const text = await r.text();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(r.status).send(text);

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
}

app.get('/lrclib/get', (req, res) => {
  proxy(req, res, 'get');
});

app.get('/lrclib/search', (req, res) => {
  proxy(req, res, 'search');
});

app.listen(3001, () => {
  console.log('LRCLIB proxy running on :3001');
});