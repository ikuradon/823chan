import * as childProcess from "node:child_process";
import * as readline from "node:readline";

const bcGetOutput = async (input) => {
    const execParams = ["-l", "-s"];

    const execOpts = {
        stdio: [
            "pipe",
            "pipe",
            "pipe",
        ]
    };

    const strfryProcess = childProcess.spawn("bc", execParams, execOpts);

    const rlOut = readline.createInterface({
        input: strfryProcess.stdout,
        crlfDelay: Infinity,
    });
    const rlErr = readline.createInterface({
        input: strfryProcess.stderr,
        crlfDelay: Infinity,
    });

    strfryProcess.stdin.write(`${input}\n`);

    strfryProcess.stdin.end();

    let stdOutput = "";
    let stdError = "";
    for await (const line of rlErr) {
        stdError += line;
    }
    for await (const line of rlOut) {
        stdOutput += `${line}\n`;
    }

    if (stdError.trim().length === 0) {
        console.log("エラー無し");
        return stdOutput.trim();
    }
    else
        return false;
};

console.log(await bcGetOutput("1+2\n3+4"));