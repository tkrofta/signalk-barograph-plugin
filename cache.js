const fs = require('fs');
const path = require('path');
const REQUEUED = 'requeued'

function push (input, cacheDir, log) {
	let data = JSON.stringify(input)
	let fileName = Date.now() + '.' + REQUEUED
	fs.writeFileSync(`${cacheDir}/${fileName}.json`, data);
	log(`Caching to ${fileName}`)
}

function load (cacheDir, log) {
    //joining path of directory 
	const fileArray = []
	const directoryPath = cacheDir;
	//passsing directoryPath and callback function
	files = fs.readdirSync(directoryPath)
	for (i=0; i<files.length; i++)
		if (files[i].includes(REQUEUED))
			fileArray.push(files[i]) 
	//console.log(files)
	if (fileArray.length == 0) {
		log('No files in cache')
		return false
	}
	else {
		return fileArray
	}
}

function send (filenames, cacheDir) {
	var input = []
	filenames.forEach(function (file) {
		if (file.includes(REQUEUED)) {
			const thisfile = fs.readFileSync(`${cacheDir}/${file}`, 'utf8')
			input.push(...JSON.parse(thisfile));
		}
	});
	
	for (const file of filenames) {
    	if (file.includes(REQUEUED))
			fs.unlink((`${cacheDir}/${file}`), err => {
				if (err) throw err;
        });
    };

	return input
}

module.exports = {
    push,
    load,
    send
}