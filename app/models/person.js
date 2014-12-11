var mongoose = require( 'mongoose' );

var personSchema = mongoose.Schema({
    first: String,
    last: String,
    guests: String
});

module.exports = mongoose.model('Person', personSchema);