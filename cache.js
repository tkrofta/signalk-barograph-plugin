const fs = require('fs');
const path = require('path');

function push (input, cacheDir, log) {
	let data = JSON.stringify(input)
	let fileName = Date.now()
	fs.writeFileSync(`${cacheDir}/${fileName}.json`, data);
	log(`Caching to ${fileName}`)
}

function load (cacheDir, log) {
    //joining path of directory 
	const fileArray = []
	const directoryPath = cacheDir;
	//passsing directoryPath and callback function
	files = fs.readdirSync(directoryPath) 
	//console.log(files)
	if (files.length == 0) {
		log('No Files in Cache')
		return false
	}
	else {
		return files
	}
}

function send (filenames, cacheDir) {
	var input = []
	filenames.forEach(function (file) {
		const thisfile = fs.readFileSync(`${cacheDir}/${file}`, 'utf8')
  		input.push(...JSON.parse(thisfile));
	});
	
	for (const file of filenames) {
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