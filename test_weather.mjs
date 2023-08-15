import axios from "axios";

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
        const weekareaData = (await axios.get(`https://www.jma.go.jp/bosai/forecast/const/week_area.json`)).data;
        const weekarea05Data = (await axios.get(`https://www.jma.go.jp/bosai/forecast/const/week_area05.json`)).data;

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
        const forecastData = (await axios.get(`${forecastUrl}${officesCode}.json`)).data;

        const forecastShort = () => {
            for (let i = 0; i < forecastData[0].timeSeries[0].areas.length; i++) {
                if (forecastData[0].timeSeries[0].areas[i].area.code === class10sCode) {
                    return forecastData[0].timeSeries[0].areas[i];
                }
            }
        }
        console.log(forecastShort);

    } catch (e) {
        console.log(e);
        message = "何か問題が発生しました…";
    }
    return message;
}

await messageWeatherForecast(process.argv[2]);