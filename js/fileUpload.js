/**
 * Funnel everything through this, in case we want to disable logging
 * ...could use log4js if not hacking
 */
function debugLog(msg) {
	msg = msg || "";

	console.log(msg);
}

/**
 * Creates basic class to handle Box API interactions
 */
function CreateBoxApi(baseUrl, apiKey, authToken) {
	var meterWrap = jQuery(".meter-wrap");

	/**
	 * Url to REST API
	 */
	function restApi(action, moreParams) {
		return baseUrl + "?rest?action=" + action + "api_key=" + apiKey
			+ "&auth_token=" + authToken + "&" + (moreParams || "");
	}

	/**
	 * If no valid folder is provided, root is assumed
	 */
	function uploadUrl(folderId) {
		folderId = folderId || "0";

		return baseUrl + "upload/" + authToken + "/" + folderId;
	}

	var meter = {
		grow : function(percent) {
			$('.meter-value').css('width', percent + '%');
			$('.meter-text').text(percent + '%');
		},
		show : function() {
			meterWrap.show();
		},
		hide : function() {
			//meterWrap.hide('medium');
			meterWrap.hide('slow');
			$('.meter-value').css('width', '0');
			$('.meter-text').text('');
		}
	};

	// @TODO this should be an instance field, figure that out...
	var estimated = {
		total : 0,
		percentage : function(progress) {
			if (this.total == 0) return 0;

			return Math.ceil(100, parseInt((progress / this.total) * 100));
		}
	};

	function extractFiles(evt) {
		var files = evt.originalEvent.dataTransfer.files;

		// @TODO determine if we want to check for file.size > LIMIT

		if (files.length < 1) {
			debugLog("No files found in event. Nothing dragged?");
			return null;
		}

		return files;

	}

	function postProgressTicker(event) {
		debugLog('Progress on upload. File size uploaded: ' + event.loaded);

		var percent = estimated.percentage(event.loaded);
		meter.grow(percent);
	}

	/**
	 * XHR completed, process it and send return to the callback function
	 */
	function xhrComplete(xhr, callback) {
		meter.hide();

		if (xhr.status !== 200) {
			debugLog('Upload returned bad status ' + xhr.status);
			debugLog('Response: ' + (xhr.responseText || ''));

			return;
		}

		var json = goessner.parseXmlStringToJsonObj(xhr.responseText);

		if (!json) {
			debugLog('Could not parse xml response =(' + xhr.responseText);
			return;
		}

		var files = json.response.files;

		if (!files) {
			debugLog('Found no files in response');
			debugLog('xml: ' + xhr.responseText);
			return;
		}

		// Force an array if only one element
		if (!files.length) {
			files = [files.file];
		}

		var fileInfo = []
		for (var f=0; f < files.length; f += 1) {
			fileInfo.push({
					id : files[f]['@id'],
					name : files[f]['@file_name']
				});
		}

		// Send file info back out to caller
		callback(fileInfo);
	}

	/**
	 * Extracts files from an event and uploads them to Box, then calls the
	 * ...callback with the info of the uploaded files as input
	 */
	function postFilesFromEvent(evt, folder, callback) {
		var files = extractFiles(evt);

		if (!files) return;

		// @TODO prob. can get rid of this method
		postFiles(files, folder, callback);
	}

	/**
	 * Uploads a collection of DOM File objects, then calls the
	 * ...callback with the info of the uploaded files as input
	 */
	function postFiles(files, folder, callback) {
		// @TODO let's hope only one upload takes place at a time
		estimated.progress = 0;

		debugLog('Attempting to upload ' + files.length + ' files.');

		// Add a form element for each file dropped
		var formData = new FormData();
		for (var f=0; f < files.length; f += 1) {
			debugLog('file: ' + files[f].name);
			formData.append("file" + f, files[f]);

			estimated.total += files[f].fileSize;
		}

		// Upload the root box folder (in bvanevery, for bvanevery@box.net)
		var xhr = new XMLHttpRequest();
		xhr.open("POST", uploadUrl(folder['folder_id']), true);

		xhr.onload = function(xhr_completed_evt) {
			debugLog('XHR completed');

			xhrComplete(xhr, callback);
		};

		// Upload specific events
		var xhrUploader = xhr.upload;
		xhrUploader.addEventListener("progress", postProgressTicker, false);

		meter.show();

		try
		{
			xhr.send(formData);
		}
		catch (e)
		{
			debugLog(e.description);
			debugLog(e);
		}
	}

	function CreateFolderApi() {
		function lookupFolder(name, callback) {
			var url = restApi("get_account_tree",
				"folder_id=0&params[]=nofiles&params[]=nozip&params[]=onelevel");

			$.get(url, function(response) {
				var json = goessner.parseXmlStringToJsonObj(response);

				var tree = json.response.tree;
				if (!tree.folders.length) {
					if (!tree.folders.folder) {
						debugLog("No folders in tree!");
						return callback(null);
					}

					// Make an array
					tree.folders = [tree.folders.folder];
				}

				// select where folder.name == name
				var foldersLen = tree.folders.length;
				for (var f=0; f < foldersLen; f += 1) {
					var folder = tree.folders[f];
					if (folder['@name'] == name) {
						return callback(folder);
					}
				}

				return callback(null);
			});
		}

		function createFolder(name, callback) {
			var urlSafeName = encodeURIComponent(name);
			// ? share=1 ?
			var url = restApi("create_folder",
				"parent_id=0&share=0&name=" + urlSafeName);

			$.get(url, function(response) {
				var json = goessner.parseXmlStringToJsonObj(response);

				if (!json) {
					debugLog("Couldn't create folder " + name);
					return;
				}

				callback(response.folder);
			});
		}

		/**
		 * Find folder or create it, then send it to the callback method
		 */
		function getOrCreateFolder(name, callback) {
			lookupFolder(name, function(folder){
				if (folder == null) {
					createFolder(name, callback);
          return;
				}

				callback(folder);
			});
		}

		function uploadFilesToFolder(evt, name, callback) {
			// No folder requested, just upload into root
			if (!name) {
				postFilesFromEvent(evt, {}, callback);
				return;
			}

			getOrCreateFolder(name, function(folder) {
				postFilesFromEvent(evt, folder, callback);
			});
		}

		// Public methods exposed for folder API
		return {
			uploadFilesToFolder : uploadFilesToFolder
		};
	}

	var folderApi = CreateFolderApi();

	return {
		folderApi : folderApi
	};
}

function on_gmail(callback) {
	var current_attempts = 0;
	var max_attempts = 200;
	var timeout = 1000;
	
	repeat_op = function(){
		debugLog("waiting for gmail...");
		if($('div').length > 25){
			callback();
		}
		else{
			current_attempts++;
			if(current_attempts < max_attempts){
				setTimeout(repeat_op, timeout);
			}
			else{
				debugLog("gmail didn't load, giving up...");
			}
		}
	}
	repeat_op();
}

$(function(){
	on_gmail(function(){
		var baseUrl = "https://bvanevery.inside-box.net/api/1.0/";
		var apiKey = "peri0kgij4frsycxon2o5ddgzce9y0y2";
		var authToken = "pav4elm92jo44hxfb2pf3e8vu536ey6q";

		var boxApi = CreateBoxApi(baseUrl, apiKey, authToken);
		
		$("head").append($("<style>"+
		"			.meter-wrap{"+
		"				position: relative;"+
		"			}"+
		"			.meter-wrap, .meter-value, .meter-text {"+
		"				/* The width and height of your image */"+
		"				width: 155px; height: 15px;"+
		"			}"+

		"			.meter-wrap, .meter-value {"+
		"				background: lightblue top left no-repeat;"+
		"			}"+

		"			.meter-value {"+
		"				background: url('img/barberpole.gif');"+
		"			}"+

		"			.meter-text {"+
		"				position: absolute;"+
		"				top:0; left:0;"+
		"				color: #fff;"+
		"				text-align: center;"+
		"				width: 100%;"+
		"			}"+
		"		</style>"))
		
		box_div = $("<div id='box_file_bin' style='position: fixed;	top: 167px;	right: 87px;	width: 200px;	height: 200px;	background-color: lightBlue;	text-align: center;'>Drop your shit here<div class='meter-wrap' style='display:none;'>			<div class='meter-value' style='background-color: #8DBAD6; width: 0%;'>				<div class='meter-text'>				</div>			</div>		</div></div>");
		$("body").append(box_div);
		
		box_div
			.bind('dragenter dragover', function(){ console.log("dragging"); }, false)
			.bind('drop', function(evt) {
				evt.stopPropagation();
				evt.preventDefault();

				boxApi.folderApi.uploadFilesToFolder(evt, '', function(uploadedFiles) {
					for (var f=0; f < uploadedFiles.length; f += 1) {
						debugLog('Uploaded file: ' + uploadedFiles[f].id + ': ' + uploadedFiles[f].name);
					}
				});
			}
		);
	})
	
});

// http://bvanevery.inside-box.net/api/1.0/rest?action=get_account_tree&api_key=peri0kgij4frsycxon2o5ddgzce9y0y2&auth_token=pav4elm92jo44hxfb2pf3e8vu536ey6q&folder_id=0&params[]=nofiles&params[]=nozip
// http://developers.box.net/w/page/12923951/ApiFunction_Upload%20and%20Download
