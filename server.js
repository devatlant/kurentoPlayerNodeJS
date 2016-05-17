/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var path = require('path');
var url = require('url');
var cookieParser = require('cookie-parser')
var express = require('express');
var session = require('express-session')
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');


var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',
        ws_uri: 'ws://docker:8888/kurento'
    }
});

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Management of sessions
 */
app.use(cookieParser());

var sessionHandler = session({
    secret : 'none',
    rolling : true,
    resave : true,
    saveUninitialized : true
});

app.use(sessionHandler);

/*
 * Definition of global variables.
 */
var sessions = {};
var candidatesQueue = {};
var kurentoClient = null;
var videoUrlToPlay = null;
/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/player'
});

var myPlayer;
var myPipeline;

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {
    var sessionId = null;
    var request = ws.upgradeReq;
    var response = {
        writeHead : {}
    };

    sessionHandler(request, response, function(err) {
        sessionId = request.session.id;
        console.log('Connection received with sessionId ' + sessionId);
    });

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'start':
            sessionId = request.session.id;
            videoUrlToPlay= message.videourl;
            start(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    return ws.send(JSON.stringify({
                        id : 'error',
                        message : error
                    }));
                }
                console.log('-------- SDP Answer : '+sdpAnswer);
                ws.send(JSON.stringify({
                    id : 'startResponse',
                    sdpAnswer : sdpAnswer
                }));
            });
            break;
        case 'stop':
            stop();
            break;
        case 'pause':
            pause();
            break;
        case 'resume':
            resume();
            break;
        case 'seek':
            seek(parseInt(message.newPosition));
            break;
        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;
        case 'getPosition':
            var position = getPosition();
            console.log('get position called');
            ws.send(JSON.stringify({
                id : 'position',
                position : position._id
            }));
            break;
        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }
        console.log("server found at "+argv.ws_uri);
        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function start(sessionId, ws, sdpOffer, callback) {
    if (!sessionId) {
        return callback('Cannot use undefined sessionId');
    }

    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }
            myPipeline = pipeline;
            pipeline.create('PlayerEndpoint',
                {uri: videoUrlToPlay},
                function(error, player)
                {
                    if (error){
                        console.log('error while creating PlayerEndpoint:'+e);
                    }
                    myPlayer = player;
                    pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint)
                    {
                        if (error){
                            console.log('error while creating WebRtcEndpoint'+error);
                        }

                        if (candidatesQueue[sessionId]) {
                            while(candidatesQueue[sessionId].length) {
                                var candidate = candidatesQueue[sessionId].shift();
                                webRtcEndpoint.addIceCandidate(candidate);
                            }
                        }

                        webRtcEndpoint.on('OnIceCandidate', function(event) {
                            var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                            ws.send(JSON.stringify({
                                id : 'iceCandidate',
                                candidate : candidate
                            }));
                        });
                        player.connect(webRtcEndpoint, function(error, pipeline){
                            if (error){
                                console.log("connect error: "+error);
                            }


                            webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
                                if (error) {
                                    pipeline.release();
                                    return callback(error);
                                }
                                return callback(null, sdpAnswer);
                            });
                            webRtcEndpoint.gatherCandidates(function(error) {
                                if (error) {
                                    pipeline.release();
                                    return callback(error);
                                }
                            });
                            webRtcEndpoint.on('MediaFlowInStateChange', function(state, pad, mediaType){
                                player.getVideoInfo(function(error, result){
                                    if (error){
                                        console.log('--error : '+error);
                                    }
                                    //FIXME find better event
                                    if (state && state.mediaType === 'VIDEO' && state.state === 'FLOWING' ){
                                        ws.send(JSON.stringify({
                                            id : 'videoInfo',
                                            'isSeekable' : result.isSeekable,
                                            'initSeekable': result.seekableInit,
                                            'endSeekable': result.seekableEnd,
                                            'videoDuration': result.duration
                                        }));
                                    }
                                });
                            });
                            player.on('EndOfStream', function(){
                                ws.send(JSON.stringify({id: 'playEnd'}));
                                myPipeline.release();
                            });

                            player.play(function(error)
                            {
                                if(error){
                                    pipeline.release();
                                    return callback(error);
                                }
                            });
                        });
                    });
                });
        });
    });
}

function createMediaElements(pipeline, ws, callback) {
    pipeline.create('PlayerEndpoint', function(error, webRtcEndpoint) {
        if (error) {
            return callback(error);
        }

        return callback(null, webRtcEndpoint);
    });
}

function connectMediaElements(webRtcEndpoint, callback) {
    webRtcEndpoint.connect(webRtcEndpoint, function(error) {
        if (error) {
            return callback(error);
        }
        return callback(null);
    });
}

function stop() {
    if (!myPlayer){
        console.log('Error player is nil!');
    }
    myPlayer.stop();
    myPipeline.release();
};

function pause(){
    if (!myPlayer){
        console.log('Error player is nil!');
    }
    myPlayer.pause();
}

function resume(){
    if (!myPlayer){
        console.log('Error player is nil!');
    }
    myPlayer.play();
}

function seek(newPosition){
    if (!myPlayer){
        console.log('Error player is nil!');
    }
    myPlayer.setPosition(newPosition);
}


function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);

    if (sessions[sessionId]) {
        console.info('Sending candidate');
        var webRtcEndpoint = sessions[sessionId].webRtcEndpoint;
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

function getPosition(){
    if (!myPlayer){
        console.log('Error player is nil!');
    }
    return myPlayer.getPosition(function(error, result){
        if(error){
            return;
        }
        return result;
    });
}

app.use(express.static(path.join(__dirname, 'static')));
