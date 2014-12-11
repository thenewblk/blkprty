var express = require('express');
var router = express.Router();
var Person = require('../app/models/person');
/* GET home page. */
router.get('/', function(req, res) {
  res.render('index', { title: 'Express' });
});

	// Add New Column
router.post('/person/new',  function(req, res) {
	var first = req.body.first;
	var last = req.body.last;
	var guests = req.body.guests;

	Person.create({ first: first, last: last, guests: guests}, function (err, person) {
	  if (err) return console.log(err);
	  	var response = {
		  	first: person.first,
		  	last: person.last,
		  	guests: person.guests
		  }

		  res.send(response);
	});
});

router.get('/totals',  function(req, res) {
	Person.find({}).exec(function(err, people) {
	  if (err) return console.log(err);
	  var solo = 0,
	  		plus1 = 0,
	  		posse = 0;
	  for (i = 0; i < people.length; i++) { 
	  	if (people[i].guests == 'solo') {
	  		solo += 1;
	  	} else if (people[i].guests == 'plus1') {
	  		plus1 += 1;
	  	} else if (people[i].guests == 'posse') {
	  		posse += 1;
	  	}

	  }
	  var total = guests + people.length;

	  var response = {
	  	solo: solo,
	  	plus1: plus1,
	  	posse: posse
	  }

	  res.send(response);
	});
});


module.exports = router;
