// config/database.js
module.exports = {

	 'url' : 
	 			process.env.MONGOLAB_URI || 
	 			'mongodb://127.0.0.1/blkprty' 
};