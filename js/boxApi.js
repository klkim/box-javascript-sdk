(function(){
boxApi = {
        url : "", // e.g. https://proxy.example.com/",
     apiKey : "", // see https://www.box.com/developers/services
  authToken : "",
    /**
     * Funnel everything through this, in case we want to disable logging
     * ...could use log4js later
     */
    dbg : function boxDbg(msg) {
        msg = msg || "";

        console.log("Box api: " + msg);
      },
    /**
     * Use this to print messages to UI
     */
    alert : function boxAlert(msg) {
      // @TODO Put this into a light box or something
      this.loadingMode(false);
      throw new BoxError(msg);
    },
    /**
     * Initialize the api and self test
     */
    init : function boxApiInit() {
      function fail(msg) {
        throw new BoxError(msg);
      }

      if (typeof(XMLHttpRequest) == "undefined") {
        fail("Box JavaScript API only supported in browsers compatible with XMLHttpRequest");
      }

      if (!boxApi.url) {
        fail("Must provide a base proxy url for contacting the api");
      }

      if (!boxApi.apiKey) {
        fail("Must provide an apiKey for contacting the api");
      }

      if (!goessner
        || typeof(goessner.parseXmlStringToJsonObj) != "function") {
        fail("Could not find goessner library. Did you forget to load it?");
      }

      var xml = "<xml>value</xml>";
      var json = goessner.parseXmlStringToJsonObj(xml);

      if (json.xml != "value") {
        fail("Goessner fail: Can't parse json from xml.");
      }

      if (!codylindley || !codylindley.swip
        || typeof(codylindley.swip.createPopup) != "function") {
        fail("Could not find codylindley popup library. Did you forget to load it?");
      }

      boxApi.dbg("Self test passed; Api Loaded");
    },
    /**
     * Load the requested API type
     * E.g. boxApi.load("folderApi") will create the folderApi object, which
     * ...can then be accessed like: boxApi.folderApi...
     */
    load : function boxApiLoad(type) {
      if (typeof(apiLoader[type]) != "function")
      {
        throw new BoxError("Invalid box api type requested, " + type);
      }

      boxApi[type] = apiLoader[type]();
    },
    /**
     * Show/hide the "loading" stuff
     */
    loadingMode : function boxApiSpinner(show) {
      // Could also do a lightbox kind of thing
      // And possibly have a cancel button
      spinnerGif[show ? "show" : "hide"]();
    }
};

// Metadata to wire the type name to the creation methods
var apiLoader = {
    authApi : CreateAuthApi,
  folderApi : CreateFileAndFolderApi
};

var spinnerGif = jQuery('#spinnerGif').hide();

// Private auth data, doesn't need to be exposed
var auth = {
     url : function() {
       return boxApi.url
         + "rest?action=get_auth_token&api_key=" + boxApi.apiKey
         + "&ticket=" + this.ticket;
     },
  ticket : "",
attempts : 30,
   token : ""
}

function CreateAuthApi() {
  /**
   * Get a ticket for using the API
   * http://developers.box.net/w/page/12923936/ApiFunction_get_ticket
   */
  function setTicket() {
    if (auth.ticket) return;

    // Block until we get a ticket
    // ...this is critical to rest of our progress
    boxApi.dbg("Blocking until we get a ticket");
    jQuery.ajax({
      url: boxApi.url + "rest?action=get_ticket&api_key=" + boxApi.apiKey,
      async: false,
      success: function(data, textStatus, jqXHR) {
        var json = goessner.parseXmlStringToJsonObj(jqXHR.responseText);

        if (!json) {
          boxApi.log("Could not create a ticket for auth token");
          throw new BoxError("Error creating ticket with Box API");
        }

        auth.ticket = json.response.ticket;
      }
    });

    if (!auth.ticket) {
      throw new BoxError("Could not load ticket for auth token from Box API");
    }

    boxApi.dbg("Loaded ticket: " + auth.ticket);
  }

  /**
   * Generate an authentication token to use for this session
   *
   * @param callback Function to call once we have an auth token
   */
  function genAuthToken(callback) {
    if (boxApi.authToken) {
      boxApi.dbg("Auth token already set");
      callback();
      return;
    }

    setTicket();

    // Let user enter credentials
    var authWindow = codylindley.swip.createPopup({
      windowURL : boxApi.url + "auth/" + auth.ticket,
      height: 700,
      width: 1200,
      top: 50,
      left: 50
    });

    if (codylindley.swip.assertOpened(authWindow)) {
      boxApi.alert("Could not open popup for authentication."
        + " Do you have popups blocked?");
      return;
    }

    // @TODO show "cancel" next to loading gif (maybe wrong password?)
    boxApi.loadingMode(true);
    pollForTokenOrGiveUp(auth.url(), 0, callback);
  }

  /**
   * Poll the get_auth_token action until it bears fruit
   * ...or give up after max attempts
   */
  function pollForTokenOrGiveUp(authUrl, cumulative, callback) {
    boxApi.dbg("Polling for auth token attempt " + cumulative);

    if (cumulative > auth.attempts) {
      boxApi.alert("Giving up on auth token after " + cumulative + " attempts");
      return;
    }

    $.get(authUrl, function(data, textStatus, jqXHR) {
      var json = goessner.parseXmlStringToJsonObj(jqXHR.responseText);

      if (!json) {
        boxApi.alert("Couldn't parse xml " + jqXHR.responseText);
        return;
      }

      // Still waiting for window to close?
      if (json.response.status == "not_logged_in") {
        setTimeout(function() {
          pollForTokenOrGiveUp(authUrl, cumulative + 1, callback);
        }, 1000);

        return;
      }

      if (json.response.status != "get_auth_token_ok") {
        // The curious user can look at the browser's xhr tab for more info
        boxApi.alert("Couldn't load auth token. Did you enter the correct creds?");
        return;
      }

      // Keep a private copy
      auth.token = json.response.auth_token;
      // Set the public version
      boxApi.authToken = auth.token;

      boxApi.loadingMode(false);
      callback();
    });
  }

  return {
    genToken : genAuthToken
  };
}

/**
 * Creates basic class to handle Box API interactions
 * with folders and files
 *
 * @TODO break folder and file apart
 */
function CreateFileAndFolderApi() {
  // Currently, only one meter per page (i.e. accurate reporting of only one
  // ...upload at a time)
  // TODO - Dynamically add progress meter elems to page per upload started
  var meter = createProgressMeter();

  /**
   * Url to REST API for current auth
   */
  function restApi(action, moreParams) {
    return boxApi.url + "rest?action=" + action + "&api_key=" + boxApi.apiKey
      + "&auth_token=" + boxApi.authToken + "&" + (moreParams || "");
  }

  /**
   * Url to which to upload files
   *
   * If no valid folder is provided, root is assumed
   */
  function uploadUrl(folder) {
    // Folder exists (@id), just created (folder_id), or root (0)
    var folderId = folder['@id'] || folder['folder_id'] || '0';

    return boxApi.url + "upload/" + boxApi.authToken + "/" + folderId;
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
      boxApi.dbg("No files found in event. Nothing dragged?");
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
      boxApi.dbg('Progress on upload. File size uploaded: ' + uploadEvt.loaded);

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
      boxApi.dbg('Upload returned bad status ' + xhr.status);
      boxApi.dbg('Response: ' + (xhr.responseText || ''));

      return;
    }

    var json = goessner.parseXmlStringToJsonObj(xhr.responseText);

    if (!json) {
      boxApi.dbg('Could not parse xml response =(' + xhr.responseText);
      return;
    }

    var files = json.response.files;

    if (!files) {
      boxApi.dbg('Found no files in response');
      boxApi.dbg('xml: ' + xhr.responseText);
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
   * Uploads a collection of DOM File objects, then calls the
   * ...callback with the info of the uploaded files as input
   */
  function postFiles(files, folder, callback) {
    if (!files) return;

    var estimated = CreateEstimationMetric();

    boxApi.dbg('Attempting to upload ' + files.length + ' files.');

    // Add a form element for each file dropped
    var formData = new FormData();
    for (var f=0; f < files.length; f += 1) {
      boxApi.dbg('file: ' + files[f].name);
      formData.append("file" + f, files[f]);

      estimated.total += files[f].fileSize;
    }

    // Upload the root box folder (in bvanevery, for bvanevery@box.net)
    var xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl(folder), true);

    xhr.onload = function(xhr_completed_evt) {
      boxApi.dbg('XHR completed');

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
      boxApi.dbg(e.description);
      boxApi.dbg(e);
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

      $.get(url, function(data, textStatus, jqXHR) {
        var json = goessner.parseXmlStringToJsonObj(jqXHR.responseText);

        var tree = json.response.tree;

        // tree.folder = root id = 0
        tree.root = tree.folder;

        if (!tree.root.folders) {
          boxApi.dbg("No folders in root!");
          return callback(null);
        }

        // Force an array if there is only one child of the root folde
        if (!tree.root.folders.folder.length) {
          tree.root.folders.folder = [tree.root.folders.folder];
        }

        // select where folder.name == name
        var foldersLen = tree.root.folders.folder.length;
        for (var f=0; f < foldersLen; f += 1) {
          var folder = tree.root.folders.folder[f];
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

      $.get(url, function(data, textStatus, jqXHR) {
        var json = goessner.parseXmlStringToJsonObj(jqXHR.responseText);

        if (!json) {
          boxApi.dbg("Couldn't create folder " + name);
          return;
        }

        callback(json.response.folder);
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

    function uploadFilesToFolder(evt, folderName, callback) {
      var files = extractFiles(evt);

      // No folder requested, just upload into root
      if (!folderName) {
        postFiles(files, {}, callback);
        return;
      }

      getOrCreateFolder(folderName, function(folder) {
        postFiles(files, folder, callback);
      });
    }

    // Public methods exposed for folder API
    return {
      uploadFilesToFolder : uploadFilesToFolder
    };
  }

  // The only method really needed is uploading files to a folder
  return CreateFolderApi();
}

/**
 * Custom error type
 */
var BoxError = jQuery.extend(Error, {});

// End define boxApi
}());

$(function(){
  boxApi.dbg("Loading...");
  /**
   * For testing by box-js-sdk developer: must allow origin in Apache on Box side
   <IfModule mod_headers.c>
     Header set Access-Control-Allow-Origin *
   </IfModule>
   * All others: TODO Explain how to do this through a same origin proxy or iframe
   * Alternative, release this as a Chrome proxy
   * ...but for now, developers will need to set up a proxy on their end
   */

  boxApi.init();
  boxApi.load("authApi");
  boxApi.load("folderApi");

  jQuery("h3.authToken").click(function() {
    boxApi.authApi.genToken(function() {
      boxApi.dbg("Got a token!");
    });
  });

  boxApi.dbg("Binding to drag events...");

  jQuery("body")
    // Must prevent default of dragover
    // ...http://asheepapart.blogspot.com/2011/11/html5-drag-and-drop-chrome-not-working.html
    .bind('dragenter dragover', function(){boxApi.dbg("dragging");}, false);
  jQuery("body")
    .bind('drop', function(evt) {
      evt.stopPropagation();
      evt.preventDefault();

      if (!boxApi.authToken) {
        boxApi.alert("No auth token, cannot upload. Please log-in.");
        return;
      }

      // Upload files to root directory
      var folderNameForUpload = '';
      boxApi.folderApi.uploadFilesToFolder(evt, folderNameForUpload, function(uploadedFiles) {
        for (var f=0; f < uploadedFiles.length; f += 1) {
          boxApi.dbg('Uploaded file: ' + uploadedFiles[f].id + ': ' + uploadedFiles[f].name);
        }
      });
    }
  );

  boxApi.dbg("Done attaching events to body.");
});

// http://developers.box.net/w/page/12923951/ApiFunction_Upload%20and%20Download
