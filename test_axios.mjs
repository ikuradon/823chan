import axios from "axios";
let response;

response = await axios.get("https://1.1.1.1")
    .then(response => {
        const { status, statusText } = response;
        console.log(`then: ${status}: ${statusText}`);
    })
    .catch(error => {
        const { status, statusText } = error.response;
        console.log(`catch: ${status}: ${statusText}`);
    });

response = await axios.get("https://h.2p.gg/status/404")
    .then(response => {
        const { status, statusText } = response;
        console.log(`then: ${status}: ${statusText}`);
    })
    .catch(error => {
        const { status, statusText } = error.response;
        console.log(`catch: ${status}: ${statusText}`);
    });

response = await axios.get("https://h.2p.gg/status/503")
    .then(response => {
        const { status, statusText } = response;
        console.log(`then: ${status}: ${statusText}`);
    })
    .catch(error => {
        const { status, statusText } = error.response;
        console.log(`catch: ${status}: ${statusText}`);
    });

response = await axios.get("http://192.0.2.10", { timeout: 5000 })
    .then(response => {
        const { status, statusText } = response;
        console.log(`then: ${status}: ${statusText}`);
    })
    .catch(error => {
        if (error.code === "ECONNABORTED")
            return console.log("catch: timeout");
        const { status, statusText } = error.response;
        console.log(`catch: ${status}: ${statusText}`);
    });