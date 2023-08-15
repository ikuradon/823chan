import { MeiliSearch } from 'meilisearch'
import { nip19 } from "nostr-tools";

const getCliArg = (errMsg) => {
    if (process.argv.length <= 2) {
        console.error(errMsg);
        process.exit(1);
    }
    return process.argv[2];
};

const client = new MeiliSearch({
    host: 'http://meilisearch:7700',
    apiKey: '99ebaa5184aecda61bd9fa569039cc8c1fc31b1dc88289f2355e857731bac1ef',
});
const index = client.index('events');

const searchNotes = async (keyword) => {
    const result = await index.search(
        keyword,
        {
            filter: [
                "kind = 1"
            ],
            limit: 5,
        },
    );
    return result.hits;
};

const messageSearchNotes = async (keyword) => {
    let message = "";
    const result = await searchNotes(keyword);
    result.forEach(data => {
        message += `nostr:${nip19.noteEncode(data.id)}\n`;
    });
    return message;
}



const content = getCliArg("error: 投稿内容をコマンドライン引数として設定してください");
console.log(await messageSearchNotes(content));