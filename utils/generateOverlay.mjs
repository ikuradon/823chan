import StaticMaps from "staticmaps";
import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";

const options = {
    width: 1024,
    height: 1024,
    tileUrl: "https://www.jma.go.jp/tile/jma/sat/{z}/{x}/{y}.png",
};

const map = new StaticMaps(options);
await map.render([137, 34.5], 5);
const mapBuffer = await map.image.save("./overlay.png");