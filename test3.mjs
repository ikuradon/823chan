import * as ENVIRONMENT from "./environment.mjs";

import * as childProcess from "node:child_process";
import * as readline from "node:readline";
import { format, fromUnixTime, getUnixTime, subDays, subMonths, subWeeks, parse } from "date-fns";
import { nip19 } from "nostr-tools";

const strfryScan = async (reqQuery) => {
    const execParams = [
        "scan",
        JSON.stringify(reqQuery)
    ];

    const execOpts = {
        stdio: [
            "ignore",
            "pipe",
            "ignore",
        ]
    };

    const strfryProcess = childProcess.spawn(ENVIRONMENT.STRFRY_EXEC_PATH, execParams, execOpts);
    const rl = readline.createInterface({
        input: strfryProcess.stdout,
        crlfDelay: Infinity,
    });

    const output = [];
    for await (const line of rl) {
        output.push(line);
    }

    return output;
};

const strfryGetMetadata = (pubkey) => {
    const reqQuery = {
        authors: [pubkey],
        kinds: [0],
        limit: 1,
    };
    const execParams = [
        "scan",
        JSON.stringify(reqQuery),
    ];
    const execOpts = {
        stdio: [
            "ignore",
            "pipe",
            "ignore",
        ]
    };

    const execOut = childProcess.execFileSync(ENVIRONMENT.STRFRY_EXEC_PATH, execParams, execOpts);
    const userInfo = execOut.toString();
    return JSON.parse(userInfo || "{}");
}

const countUserEvents = (events) => {
    const users = {};
    for (const event of events) {
        const eventData = JSON.parse(event);
        const userId = eventData.pubkey;
        if (users[userId])
            users[userId]++;
        else
            users[userId] = 1;
    }
    const userArray = Object.keys(users).map((k) => ({ key: k, value: users[k] }));
    userArray.sort((left, right) => right.value - left.value);
    return userArray;
};

const generateRanking = (input) => {
    const rankingHeader = ["🥇", "🥈", "🥉", "4⃣", "5⃣", "6⃣", "7⃣", "8⃣", "9⃣", "🔟"];

    const userArray = input.splice(0, 10);

    let message = "";
    for (let index = 0; index < userArray.length; index++) {
        const user = userArray[index];

        const metadata = strfryGetMetadata(user.key);
        // console.log(metadata);
        const userInfo = JSON.parse(metadata.content || "{}");
        let userName = userInfo.display_name || userInfo.displayName || undefined;
        const userNpub = nip19.npubEncode(user.key);
        if (userName != undefined)
            message += `${rankingHeader[index]} ${user.value} ${userName} (nostr:${userNpub})\n`;
        else
            message += `${rankingHeader[index]} ${user.value} nostr:${userNpub}\n`;
    }
    return message.trim();
}

console.log("ランキング生成");
const currentDay = new Date(new Date().setHours(0, 0, 0, 0));
const startDay = subDays(currentDay, 1);
const events = await strfryScan({ kinds: [1, 6, 7,], since: getUnixTime(startDay), until: getUnixTime(currentDay - 1) });
const userListKind1 = countUserEvents(events.filter(event => JSON.parse(event).kind === 1));
const userListKind6 = countUserEvents(events.filter(event => JSON.parse(event).kind === 6));
const userListKind7 = countUserEvents(events.filter(event => JSON.parse(event).kind === 7));


let message = "";

console.log(`${format(startDay, "yyyy-MM-dd HH:mm")} → ${format(currentDay - 1, "yyyy-MM-dd HH:mm")}`)
console.log("kind: 1");
console.log(generateRanking(userListKind1));
console.log("kind: 6");
console.log(generateRanking(userListKind6));
console.log("kind: 7");
console.log(generateRanking(userListKind7));
// console.log(`ノート(kind: 1)ランキングです！\n集計期間：${format(yesterDay, "yyyy-MM-dd HH:mm")} → ${format(currentDay - 1, "yyyy-MM-dd HH:mm")}\n\n${generateRanking(userListKind1)}`);