var ws = require("nodejs-websocket"),
    express = require("express");

process.stdout.on("error", function(err) {
    console.log("ERROR:", err, err.code);
    switch (err.code) {
        case "EPIPE":
            break;
        default:
            process.exit(0);
    }
});

var app = express(),
    httpServer = require("http").createServer(app);

app.get("/test", function(req, res) {
    console.log(req);
});
httpServer.listen(process.env.PORT || 8000);

var wsServer = null;
var settings = {
    pingInterval: 30*1000, // ms
    sessionTimeout: 2*60*1000 // ms
};
var errors = {
    msgFailed: "Message construction failed.",
    sendFailed: "Message sending failed.",
    parseFailed: "Message parse failed.",
    malformed: "Message malformed.",
    unknownHeader: "Unknown header."
};

// id: {connections: [id], timeout: f}
var sessions = {};

// sessionId: {contact: "", tier: "", region: ""}
var scrims = {};
var tiers = ["Low", "Mid", "High", "High+", "High++"];
var regions = ["SEA", "NA", "EU"];

function idToClient(id) {
    for (var i = 0; i < wsServer.connections.length; i++) {
        if (wsServer.connections[i].id === id) return wsServer.connections[i];
    }
    return null;
}

function message(header, body) {
    console.log("Constructing message...");
    var m = {header: header.toUpperCase(), body: body, timestamp: +new Date()};
    try {
        m = JSON.stringify(m);
    } catch (e) {
        return {message: null, error: e};
    } finally {
        return {message: m, error: null};
    }
}

function send(sid, header, body) {
    console.log("Sending message to session...");
    var m = message(header, body);
    if (m.error) {
        console.log("Error:", errors.msgFailed, m.error);
        return;
    }
    if (!(sid in sessions)) {
        console.log("Error:", errors.sendFailed, "Session with that ID not found.", sid);
        return;
    }
    console.log(sid, "<-", header, body);
    sessions[sid].connections.forEach(function(id) {
        try {
            var c = idToClient(id);
            console.log("Sending message to a client...");
            if (c && c.readyState === c.OPEN) c.send(m.message);
        } catch(err) {
            console.log("Error:", errors.sendFailed, err);
        }
    });
}

function broadcast(header, body) {
    console.log("Broadcasting message...");
    for (sid in sessions) {
        send(sid, header, body);
    }
}

function pinger() {
    setInterval(function () {
        console.log("Pinging...");
        broadcast("PING", null);
    }, settings.pingInterval);
}

function merge(conn, sid) {
    console.log("Merging sessions...");
    if (conn.sessionId === sid) return;
    if (!(sid in sessions)) {
        sessions[sid] = {connections: [conn.id], timeout: function() {}};
        delete scrims[conn.sessionId];
        delete sessions[conn.sessionId];
        conn.sessionId = sid;
        return;
    }

    delete sessions[conn.sessionId];
    clearTimeout(sessions[sid].timeout);
    sessions[sid].connections.push(conn.id);

    if (conn.sessionId in scrims) {
        scrims[sid] = scrims[conn.sessionId];
        delete scrims[conn.sessionId];
        update();
    }
    conn.sessionId = sid;
}

function update() {
    console.log("Constructing message...");
    var data = [];
    for (k in scrims) {
        data.push(scrims[k]);
    }
    broadcast("UPDATE", data);
    console.log("Scrims:", data);
}

function handle(conn, data) {
    if (!("header" in data) || !("body" in data)) {
        send(conn.sessionId, "ERROR", errors.malformed);
        return;
    }
    data.header = data.header || "";
    data.body = data.body || "";

    switch (data.header.toUpperCase()) {
        case "IDENT":
            var oldSid = data.body;
            if (oldSid) {
                console.log("Switch", conn.sessionId, "to", oldSid);
                merge(conn, oldSid);
            }
            break;
        case "SET":
            if (typeof data.body !== "object") {
                send(conn.sessionId, "ERROR", errors.malformed);
                break;
            }
            if (!("tier" in data.body) || !("region" in data.body) || !("contact" in data.body)) {
                send(conn.sessionId, "ERROR", errors.malformed);
                break;
            }
            if (tiers.indexOf(data.body.tier) < 0 || regions.indexOf(data.body.region) < 0 || data.body.contact.length > 20) {
                send(conn.sessionId, "ERROR", errors.malformed);
                break;
            }
            scrims[conn.sessionId] = {contact: data.body.contact, region: data.body.region, tier: data.body.tier};
            update();
            break;
        case "CLEAR":
            delete scrims[conn.sessionId];
            update();
            break;
        case "PONG":
            break;
        case "SESSIONS":
            console.log(Object.keys(sessions));
            break;
        default:
            send(conn.sessionId, "ERROR", errors.unknownHeader + ": " + data.header);
    }
}

pinger();
wsServer = ws.createServer(function(conn) {
    conn.id = uuid();
    conn.sessionId = uuid();
    sessions[conn.sessionId] = {connections: [conn], timeout: function() {}};
    console.log(conn.sessionId, "connected.");
    send(conn.sessionId, "IDENT", conn.sessionId);
    update();

    conn.on("text", function(str) {
        var data;
        try {
            data = JSON.parse(str);
        } catch(err) {
            console.log("Error:", errors.parseFailed, err);
            return;
        }
        if (!data) return;
        console.log("Received:", data);
        handle(conn, data);
    });

    conn.on("close", function(code, reason) {
        console.log(conn.id, "disconnected:", code, reason);
        if (conn.sessionId in sessions) {
            for (var i = 0; i < sessions[conn.sessionId].connections.length; i++) {
                var id = sessions[conn.sessionId].connections[i];
                if (id === conn.id) {
                    sessions[conn.sessionId].connections.splice(i, 1);
                    break;
                }
            }
            if (sessions[conn.sessionId].connections.length < 1) {
                sessions[conn.sessionId].timeout = setTimeout(function() {
                    delete scrims[conn.sessionId];
                    delete sessions[conn.sessionId];
                    update();
                }, settings.sessionTimeout);
            }
        }
    });
}).listen(httpServer);

function uuid(a){
    return a?(a^Math.random()*16>>a/4).toString(16):([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,uuid)
}
