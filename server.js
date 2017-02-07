var ws = require("nodejs-websocket");

// {header: "", body: "", timestamp: ""}
// {contact: "", tier: "", region: ""}
var server;
var errors = {
    "malformed": "Malformed data",
    "unknownHeader": "Unknown header"
}

var tiers = ["Low", "Mid", "High", "High+", "High++"];
var regions = ["SEA", "NA", "EU"];

var conns = {};
var scrims = {};
var cancels = {};
var pingers = {};

function msg(header, body) {
    var data = null;
    try {
        data = JSON.stringify({
            header: header.toUpperCase(),
            body: body,
            timestamp: +new Date()
        });
    } catch(err) {
        console.log(err);
    }
    return data;
}

function send(conn, header, body) {
    try {
        var m = msg(header, body);
        if (!m) throw "JSON.stringify failed";
        conn.send(m);
        console.log("Sent", header);
    } catch(err) {
        console.log(err);
    }
}

function broadcast(header, data) {
    server.connections.forEach(function(conn) {
        send(conn, header, data);
    })
}

function ping(id) {
    return setInterval(function() {
        send(conns[id], "PING", +new Date());
    }, 30 * 1000);
}

function handle(id, data) {
    if (!("header" in data) || !("body" in data)) {
        send(conns[id], "ERROR", errors.malformed);
        return;
    }
    data.header = data.header || "";
    data.body = data.body || "";

    switch (data.header.toUpperCase()) {
        case "IDENT":
            var oldId = parseInt(data.body);
            if (isFinite(oldId)) {
                console.log("Switch", id, oldId);

                conns[oldId] = conns[id];
                conns[oldId].id = oldId;
                delete conns[id];

                clearTimeout(cancels[oldId]);
                delete cancels[oldId];

                pingers[oldId] = ping(oldId);
                clearTimeout(pingers[id]);
                delete pingers[id];

                if (id in scrims) {
                    scrims[oldId] = scrims[id];
                    delete scrims[id];
                    console.log("Scrims:", scrims);
                }
            }
            break;
            return;
        case "SET":
            if (typeof data.body !== "object") {
                send(conns[id], "ERROR", errors.malformed);
                break;
            }
            if (!("tier" in data.body) || !("region" in data.body) || !("contact" in data.body)) {
                send(conns[id], "ERROR", errors.malformed);
                break;
            }
            if (tiers.indexOf(data.body.tier) < 0 || regions.indexOf(data.body.region) < 0 || data.body.contact.length > 20) {
                send(conns[id], "ERROR", errors.malformed);
                break;
            }
            scrims[id] = {contact: data.body.contact, region: data.body.region, tier: data.body.tier};
            console.log("Scrims:", scrims);
            broadcast("UPDATE", scrims);
            break;
        case "CLEAR":
            delete scrims[id];
            console.log("Scrims:", scrims);
            broadcast("UPDATE", scrims);
            break;
        case "PONG":
            break;
        default:
            send(conns[id], "ERROR", errors.unknownHeader);
    }
}

server = ws.createServer(function(conn) {
    conn.id = +new Date;
    conns[conn.id] = conn;
    console.log("Connection", conn.id);
    while (conn.readyState == conn.CONNECTING) {}
    send(conn, "IDENT", conn.id);
    send(conn, "UPDATE", scrims);
    pingers[conn.id] = ping(conn.id);

    conn.on("text", function(str) {
        var data;
        try {
            data = JSON.parse(str);
        } catch(err) {
            console.log("Error:", err, conn.id);
            return;
        }
        if (!data) return;
        console.log("Received:", data);
        handle(conn.id, data);
    });

    conn.on("close", function(code, reason) {
        delete conns[conn.id];
        delete pingers[conn.id];
        console.log("Closed", conn.id, code, reason);
        cancels[conn.id] = setTimeout(function() {
            clearInterval(pingers[conn.id]);
            delete scrims[conn.id];
            delete cancels[conn.id];
            broadcast("UPDATE", scrims);
        }, 60 * 1000);
    });
}).listen(process.env.PORT || 8000);
