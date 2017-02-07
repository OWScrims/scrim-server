var ws = require("nodejs-websocket");

var server = null;
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

// id: {connections: [], timeout: f, pinger: f}
var sessions = {};

// sessionId: {contact: "", tier: "", region: ""}
var scrims = {};
var tiers = ["Low", "Mid", "High", "High+", "High++"];
var regions = ["SEA", "NA", "EU"];

function message(header, body) {
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
    var m = message(header, body);
    if (m.error) {
        console.log("Error:", errors.msgFailed, m.error);
    }
    if (!(sid in sessions)) {
        console.log("Error:", errors.sendFailed, "Session with that ID not found.");
        return;
    }
    console.log(sid, "<-", header, body);
    sessions[sid].connections.forEach(function(c) {
        try {
            c.send(m.message);
        } catch(err) {
            console.log("Error:", errors.sendFailed, err);
        }
    });
}

function broadcast(header, body) {
    for (var i = 0; i < sessions.length; i++) {
        send(sessions[i], header, body);
    }
}

function pinger(id) {
    return setInterval(function () {
        send(id, "PING", null);
    }, settings.pingInterval);
}

function merge(conn, sid) {
    if (conn.sessionId === sid) return;
    clearInterval(sessions[conn.sessionId].pinger);
    if (!(sid in sessions)) {
        sessions[sid] = {connections: [conn], pinger: pinger(conn.sid), timeout: function() {}};
        delete scrims[conn.sessionId];
        delete sessions[conn.sessionId];
        conn.sessionId = sid;
        return;
    }

    delete sessions[conn.sessionId];
    clearTimeout(sessions[sid].timeout);
    sessions[sid].connections.push(conn);

    if (conn.sessionId in scrims) {
        scrims[sid] = scrims[conn.sessionId];
        delete scrims[conn.sessionId];
        update();
    }
    conn.sessionId = sid;
}

function update() {
    broadcast("UPDATE", scrims);
    console.log("Scrims:", scrims);
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
            var oldSid = parseInt(data.body);
            if (isFinite(oldSid)) {
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
        default:
            send(conns[conn.sessionId], "ERROR", errors.unknownHeader);
    }
}

server = ws.createServer(function(conn) {
    conn.id = +new Date();
    conn.sessionId = +new Date();
    while (conn.readyState == conn.CONNECTING) {}
    sessions[conn.sessionId] = {connections: [conn], pinger: pinger(conn.sessionId), timeout: function() {}};
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
        if (conn.sessionId in sessions) {
            for (var i = 0; i < sessions[conn.sessionId].connections.length; i++) {
                var c = sessions[conn.sessionId].connections[i];
                if (c.id === conn.id) {
                    sessions[conn.sessionId].connections.splice(i, 1);
                    break;
                }
            }
            if (sessions[conn.sessionId].connections.length < 1) {
                sessions[conn.sessionId].timeout = setTimeout(function() {
                    delete scrims[conn.sessionId];
                    clearInterval(sessions[conn.sessionId].pinger);
                    delete sessions[conn.sessionId];
                    update();
                }, settings.sessionTimeout);
            }
        }
    });
}).listen(process.env.PORT || 8000);
