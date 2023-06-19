import axios from "axios";
import { isExists } from "date-fns";

const areaData = (await axios.get(`https://www.jma.go.jp/bosai/common/const/area.json`)).data;
const muniCode = "0410100";

const class20sData = Object.entries(areaData.class20s).sort((left, right) => {
    if (Number(left[0]) < Number(right[0])) return -1;
    if (Number(left[0]) > Number(right[0])) return 1;
    return 0;
});
console.log(class20sData.find(record => Number(record[0] >= muniCode))[1]);
let left = 0, mid = 0, right = class20sData.length;
while (right - left > 1) {
    mid = Math.floor((left + right) / 2);
    if (Number(muniCode) === Number(class20sData[mid][0]))
        break;
    else if (Number(muniCode) > Number(class20sData[mid][0]))
        left = mid;
    else
        right = mid;
}
if (Number(muniCode) < Number(class20sData[mid][0]))
    mid--;

console.log(class20sData[mid][1])