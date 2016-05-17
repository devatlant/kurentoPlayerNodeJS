# kurentoPlayerNodeJS
Kurento player with NodeJS

## Installation

```bash
npm install
```

## Running

```bash
npm start -- --ws_uri=ws://localhost:8888/kurento
```
Note: Kurento Media Server should be up and running. To simplify the Kurento installation, I suggest you to use the official kurento Docker image from [Docker hub](https://hub.docker.com/r/kurento/kurento-media-server/)

Next, open any WebRTC compatible browser (FireFox, Chrome, Opera) and go to 
```bash
https://127.0.0.1:8443
```

You have to accept the untrsuted certificate within your Browser to be able to see the app.
