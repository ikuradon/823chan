import axios from "axios";
import { format, fromUnixTime, getUnixTime, subDays, subMonths, subWeeks, parse } from "date-fns";
import * as CONST from "./const.mjs";


const getLocation = async (location) => {
    if (!location)
        return false;

    return (await axios.get(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${location}`)).data;
}

const messageWeatherForecast = async (location) => {
    let message = "";
    try {
        const geoDataItems = await getLocation(location);
        if (!geoDataItems.length)
            return "知らない場所です…";
        const geoData = geoDataItems[0];

        console.log(geoData);
        message += `${geoData.properties.title}の天気です！ (気象庁情報)\n`;
        const coordinates = geoData.geometry.coordinates;
        const addressData = (await axios.get(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lon=${coordinates[0]}&lat=${coordinates[1]}`)).data;
        console.log(addressData.results);
        const muniCode = addressData.results.muniCd + "00";
        console.log(muniCode);
        const areaData = (await axios.get(`https://www.jma.go.jp/bosai/common/const/area.json`)).data;

        const class20sData = Object.entries(areaData.class20s).sort((left, right) => {
            if (Number(left[0]) < Number(right[0])) return -1;
            if (Number(left[0]) > Number(right[0])) return 1;
            return 0;
        });
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


        const class15sCode = class20sData[mid][1].parent;
        console.log(class15sCode);
        const class10sCode = Object.entries(areaData.class15s).filter(record => (record[0] === class15sCode))[0][1].parent;
        console.log(class10sCode);
        const officesCode = Object.entries(areaData.class10s).filter(record => (record[0] === class10sCode))[0][1].parent;
        console.log(officesCode);

        const forecastUrl = "https://www.jma.go.jp/bosai/forecast/data/forecast/";
        const response = await axios.get(`${forecastUrl}${officesCode}.json`);

        let arrayId = 0;
        for (let i = 0; i < response.data[0].timeSeries[0].areas.length; i++) {
            if (response.data[0].timeSeries[0].areas[i].area.code === class10sCode) {
                arrayId = i;
                break;
            }
        }

        const forecastsShort = response.data[0].timeSeries;

        const forecastsShortTemps = forecastsShort[2].areas[arrayId].temps;
        if (9 <= new Date().getHours() && new Date().getHours() < 18)
            forecastsShortTemps.splice(1, 1);
        const forecastsShortTempsLength = forecastsShortTemps.length;
        for (let i = 0; i < 4 - forecastsShortTempsLength; i++)
            forecastsShortTemps.unshift("--");

        const forecastShortPops = forecastsShort[1].areas[arrayId].pops.map(element => element.padStart(3, " ") + "%");
        const forecastShortPopsLength = forecastShortPops.length
        for (let i = 0; i < 8 - forecastShortPopsLength; i++) {
            forecastShortPops.unshift("----");
        }

        const forecastsLong = response.data[1].timeSeries;
        const timeDefinesLong = forecastsLong[0].timeDefines;
        const forecastLongAreas = [];
        for (let i = 0; i < forecastsLong[0].areas.length; i++) {
            forecastLongAreas[i] = {
                weather: forecastsLong[0].areas[i],
                amedas: forecastsLong[1].areas[i],
            }
        }

        const area = forecastLongAreas[arrayId];
        message += `${format(new Date(forecastsShort[0].timeDefines[0]), "yyyy-MM-dd")} ${forecastsShortTemps[0]}/${forecastsShortTemps[1]} ${forecastsShort[0].areas[arrayId].weathers[0]}\n`;
        message += `降水確率: ${[...forecastShortPops].slice(0, 4).join(" / ")}\n`;
        message += `${format(new Date(forecastsShort[0].timeDefines[1]), "yyyy-MM-dd")} ${forecastsShortTemps[2]}/${forecastsShortTemps[3]} ${forecastsShort[0].areas[arrayId].weathers[1]}\n`;
        message += `降水確率: ${[...forecastShortPops].slice(4).join(" / ")}\n`;

        message += "---------------\n";

        for (let i = 2; i < timeDefinesLong.length; i++) {
            message += `${format(new Date(timeDefinesLong[i]), "yyyy-MM-dd")} (${area.weather.reliabilities[i]}) ${area.amedas.tempsMin[i]}/${area.amedas.tempsMax[i]} ${area.weather.pops[i]}% ${CONST.TELOPS[area.weather.weatherCodes[i]][3]}\n`;
        }

        message += "---------------\n";

        const forecastData = (await axios.get(`https://www.jma.go.jp/bosai/forecast/data/overview_forecast/${officesCode}.json`)).data;
        console.log(forecastData.text);
        message += forecastData.text;
    } catch (e) {
        console.log(e);
        message = "何か問題が発生しました…";
    }
    return message;
}

console.log(messageWeatherForecast("御殿場"));