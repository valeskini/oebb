const oebb = require(".");
const { DateTime } = require('luxon')

const berlin = "8011160";
const hamburg = "8002549";
const vienna = {
	type: "station",
	id: "1190100",
	name: "Wien",
};
	const when = DateTime.fromJSDate(new Date(), { zone: 'Europe/Vienna' }).plus({ days: 10 }).startOf('day').plus({ hours: 5 }).toJSDate()
oebb.journeys(berlin, vienna, { when, prices: true }).then((journeys) => {
	console.log(JSON.stringify(journeys, null, 2));
});
