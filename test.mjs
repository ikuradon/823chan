import * as ENVIRONMENT from "./environment.mjs";

import * as childProcess from "node:child_process";
import * as readline from "node:readline";
import { format, fromUnixTime, getUnixTime, subDays, subMonths, subWeeks, parse } from "date-fns";

const date = new Date();

date.setDate(date.getDate() - 1);
date.setDate(date.getDate() - 1);
const reqQuery = {
    kinds: [1,],
    since: getUnixTime(date),
    until: getUnixTime(new Date()),
}

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

const userList = {};
for await (const line of rl) {
    // console.log(JSON.parse(line));
    const eventData = JSON.parse(line);
    const userId = eventData.pubkey;
    let skip = false;
    eventData.tags.forEach(element => {
        if (element[0] === "mostr")
            skip = true;
    });
    if (skip)
        continue;
    if (userList[userId])
        userList[userId]++;
    else
        userList[userId] = 1;
}
const userArray = Object.keys(userList).map((k) => ({ key: k, value: userList[k] }));
userArray.sort((left, right) => right.value - left.value);
console.log(`count: ${userArray.length}`);
console.log(`exclude event<=1: ${userArray.filter(record => record.value > 1).length}`);
console.log(`exclude event<10: ${userArray.filter(record => record.value >= 10).length}`);
console.log(`exclude event<20: ${userArray.filter(record => record.value >= 20).length}`);
console.log(`exclude event<30: ${userArray.filter(record => record.value >= 30).length}`);
console.log(`exclude event<40: ${userArray.filter(record => record.value >= 40).length}`);
console.log(`exclude event<50: ${userArray.filter(record => record.value >= 50).length}`);
console.log(`exclude event<60: ${userArray.filter(record => record.value >= 60).length}`);
console.log(`exclude event<70: ${userArray.filter(record => record.value >= 70).length}`);
console.log(`exclude event<80: ${userArray.filter(record => record.value >= 80).length}`);
console.log(`exclude event<90: ${userArray.filter(record => record.value >= 90).length}`);
console.log(`exclude event<100: ${userArray.filter(record => record.value >= 100).length}`);

const ranking = [...userArray].splice(0, 10);
console.log(ranking);
