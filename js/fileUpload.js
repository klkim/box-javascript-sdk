/**
 * Funnel everything through this, in case we want to disable logging
 * ...could use log4js later
 */
function boxLog(msg) {
	msg = msg || "";

	console.log("Box api: " + msg);
}

/**
 * Creates basic class to handle Box API interactions
 */
function CreateBoxApi(baseUrl, apiKey, authToken) {
  authToken = authToken || genAuthToken();

  // Currently, only one meter per page (i.e. accurate reporting of only one
  // ...upload at a time)
  // TODO - Dynamically add progress meter elems to page per upload started
  var meter = createProgressMeter();

  /**
   * Generate an authentication token to use for this session
   */
  function genAuthToken() {
    var boxUrl = baseUrl + "?rest=action=get_ticket&api_key=" + apiKey;

    var ticket;
    $.ajax({
      url: boxUrl,
      async: false,
      success: function(response) {
        var json = goessner.parseXmlStringToJsonObj(response);

        if (!json) {
          boxLog("Could not create a ticket for auth token");
          throw new Exception("Error creating ticket with Box API");
        }

        ticket = json.response.ticket;
      }
    });

    // Let user enter credenetials at:
    // "https://www.box.net/api/1.0/auth/" + ticket

    // Call baseUrl + "rest?action=get_auth_token&api_key=" + apiKey
    // ...to get the auth_token

    throw new Exception("Not implemented yet!")
  }
	/**
	 * Url to REST API for current auth
	 */
	function restApi(action, moreParams) {
		return baseUrl + "?rest?action=" + action + "api_key=" + apiKey
			+ "&auth_token=" + authToken + "&" + (moreParams || "");
	}

	/**
   * Url to which to upload files
   *
	 * If no valid folder is provided, root is assumed
	 */
	function uploadUrl(folderId) {
		folderId = folderId || "0";

		return baseUrl + "upload/" + authToken + "/" + folderId;
	}

  /**
   * The meter that will show the progress of the upload
   */
  function createProgressMeter() {
    var meterWrap = jQuery(".meter-wrap");

    return {
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
  }

  /**
   * Simple object to manage current estimation of the upload progress
   */
  function CreateEstimationMetric() {
    return {
      total : 0,
      percentage : function(progress) {
        if (this.total == 0) return 0;

        return Math.ceil(100, parseInt((progress / this.total) * 100));
      }
    };
  }

  /**
   * Extract the requested files for upload from drop event
   */
	function extractFiles(evt) {
		var files = evt.originalEvent.dataTransfer.files;

		// @TODO determine if we want to check for file.size > LIMIT

		if (files.length < 1) {
			boxLog("No files found in event. Nothing dragged?");
			return null;
		}

		return files;
	}

  /**
   * Return a function that will calculate the estimated completion based on
   * data in an upload event
   */
  function CreateProgressTicker(estimationMetrics) {
    return function(uploadEvt) {
      boxLog('Progress on upload. File size uploaded: ' + uploadEvt.loaded);

      var percent = estimationMetrics.percentage(uploadEvt.loaded);
      meter.grow(percent);
    }
  }

	/**
	 * XHR completed, process it and send return to the callback function
	 */
	function xhrComplete(xhr, callback) {
		meter.hide();

		if (xhr.status !== 200) {
			boxLog('Upload returned bad status ' + xhr.status);
			boxLog('Response: ' + (xhr.responseText || ''));

			return;
		}

		var json = goessner.parseXmlStringToJsonObj(xhr.responseText);

		if (!json) {
			boxLog('Could not parse xml response =(' + xhr.responseText);
			return;
		}

		var files = json.response.files;

		if (!files) {
			boxLog('Found no files in response');
			boxLog('xml: ' + xhr.responseText);
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

		postFiles(files, folder, callback);
	}

	/**
	 * Uploads a collection of DOM File objects, then calls the
	 * ...callback with the info of the uploaded files as input
	 */
	function postFiles(files, folder, callback) {
    var estimated = CreateEstimationMetric();

		boxLog('Attempting to upload ' + files.length + ' files.');

		// Add a form element for each file dropped
		var formData = new FormData();
		for (var f=0; f < files.length; f += 1) {
			boxLog('file: ' + files[f].name);
			formData.append("file" + f, files[f]);

			estimated.total += files[f].fileSize;
		}

		// Upload the root box folder (in bvanevery, for bvanevery@box.net)
		var xhr = new XMLHttpRequest();
		xhr.open("POST", uploadUrl(folder['folder_id']), true);

		xhr.onload = function(xhr_completed_evt) {
			boxLog('XHR completed');

			xhrComplete(xhr, callback);
		};

		// Upload specific events
		var xhrUploader = xhr.upload;
		xhrUploader.addEventListener("progress", CreateProgressTicker(estimated), false);

		meter.show();

		try
		{
			xhr.send(formData);
		}
		catch (e)
		{
			boxLog(e.description);
			boxLog(e);
      meter.hide();
		}
	}

  /**
   * API into folder specific things
   */
	function CreateFolderApi() {
		function lookupFolder(name, callback) {
			var url = restApi("get_account_tree",
				"folder_id=0&params[]=nofiles&params[]=nozip&params[]=onelevel");

			$.get(url, function(response) {
				var json = goessner.parseXmlStringToJsonObj(response);

				var tree = json.response.tree;
				if (!tree.folders.length) {
					if (!tree.folders.folder) {
						boxLog("No folders in tree!");
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
			var url = restApi("create_folder",
				"parent_id=0&share=0&name=" + urlSafeName);

			$.get(url, function(response) {
				var json = goessner.parseXmlStringToJsonObj(response);

				if (!json) {
					boxLog("Couldn't create folder " + name);
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

  // The only method really needed is uploading files to a folder
	return {
		folderApi : folderApi
	};
}

$(function(){
  boxLog("Loading...");
  /**
   * For testing by box-js-sdk developer: must allow origin in Apache on Box side
   <IfModule mod_headers.c>
     Header set Access-Control-Allow-Origin *
   </IfModule>
   * All others: TODO Explain how to do this through a same origin proxy
   * Alternative, release this as a Chrome proxy
   */
  var baseUrl = "https://bvanevery.inside-box.net/api/1.0/";
  var apiKey = "peri0kgij4frsycxon2o5ddgzce9y0y2";
  var authToken = "pav4elm92jo44hxfb2pf3e8vu536ey6q";

  var boxApi = CreateBoxApi(baseUrl, apiKey, "");

  boxLog("Binding to drag events...");

  jQuery("body")
    // Must prevent default of dragover
    // ...http://asheepapart.blogspot.com/2011/11/html5-drag-and-drop-chrome-not-working.html
    .bind('dragenter dragover', function(){ boxLog("dragging"); }, false);
  jQuery("body")
    .bind('drop', function(evt) {
      evt.stopPropagation();
      evt.preventDefault();

      // Upload files to root directory
      boxApi.folderApi.uploadFilesToFolder(evt, '', function(uploadedFiles) {
        for (var f=0; f < uploadedFiles.length; f += 1) {
          boxLog('Uploaded file: ' + uploadedFiles[f].id + ': ' + uploadedFiles[f].name);
        }
      });
    }
  );

  boxLog("Done attaching events to body.");
});

// http://developers.box.net/w/page/12923951/ApiFunction_Upload%20and%20Download
