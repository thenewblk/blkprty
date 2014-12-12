(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule AutoFocusMixin
 * @typechecks static-only
 */

"use strict";

var focusNode = require("./focusNode");

var AutoFocusMixin = {
  componentDidMount: function() {
    if (this.props.autoFocus) {
      focusNode(this.getDOMNode());
    }
  }
};

module.exports = AutoFocusMixin;

},{"./focusNode":111}],2:[function(require,module,exports){
/**
 * Copyright 2013 Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule BeforeInputEventPlugin
 * @typechecks static-only
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPropagators = require("./EventPropagators");
var ExecutionEnvironment = require("./ExecutionEnvironment");
var SyntheticInputEvent = require("./SyntheticInputEvent");

var keyOf = require("./keyOf");

var canUseTextInputEvent = (
  ExecutionEnvironment.canUseDOM &&
  'TextEvent' in window &&
  !('documentMode' in document || isPresto())
);

/**
 * Opera <= 12 includes TextEvent in window, but does not fire
 * text input events. Rely on keypress instead.
 */
function isPresto() {
  var opera = window.opera;
  return (
    typeof opera === 'object' &&
    typeof opera.version === 'function' &&
    parseInt(opera.version(), 10) <= 12
  );
}

var SPACEBAR_CODE = 32;
var SPACEBAR_CHAR = String.fromCharCode(SPACEBAR_CODE);

var topLevelTypes = EventConstants.topLevelTypes;

// Events and their corresponding property names.
var eventTypes = {
  beforeInput: {
    phasedRegistrationNames: {
      bubbled: keyOf({onBeforeInput: null}),
      captured: keyOf({onBeforeInputCapture: null})
    },
    dependencies: [
      topLevelTypes.topCompositionEnd,
      topLevelTypes.topKeyPress,
      topLevelTypes.topTextInput,
      topLevelTypes.topPaste
    ]
  }
};

// Track characters inserted via keypress and composition events.
var fallbackChars = null;

// Track whether we've ever handled a keypress on the space key.
var hasSpaceKeypress = false;

/**
 * Return whether a native keypress event is assumed to be a command.
 * This is required because Firefox fires `keypress` events for key commands
 * (cut, copy, select-all, etc.) even though no character is inserted.
 */
function isKeypressCommand(nativeEvent) {
  return (
    (nativeEvent.ctrlKey || nativeEvent.altKey || nativeEvent.metaKey) &&
    // ctrlKey && altKey is equivalent to AltGr, and is not a command.
    !(nativeEvent.ctrlKey && nativeEvent.altKey)
  );
}

/**
 * Create an `onBeforeInput` event to match
 * http://www.w3.org/TR/2013/WD-DOM-Level-3-Events-20131105/#events-inputevents.
 *
 * This event plugin is based on the native `textInput` event
 * available in Chrome, Safari, Opera, and IE. This event fires after
 * `onKeyPress` and `onCompositionEnd`, but before `onInput`.
 *
 * `beforeInput` is spec'd but not implemented in any browsers, and
 * the `input` event does not provide any useful information about what has
 * actually been added, contrary to the spec. Thus, `textInput` is the best
 * available event to identify the characters that have actually been inserted
 * into the target node.
 */
var BeforeInputEventPlugin = {

  eventTypes: eventTypes,

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {

    var chars;

    if (canUseTextInputEvent) {
      switch (topLevelType) {
        case topLevelTypes.topKeyPress:
          /**
           * If native `textInput` events are available, our goal is to make
           * use of them. However, there is a special case: the spacebar key.
           * In Webkit, preventing default on a spacebar `textInput` event
           * cancels character insertion, but it *also* causes the browser
           * to fall back to its default spacebar behavior of scrolling the
           * page.
           *
           * Tracking at:
           * https://code.google.com/p/chromium/issues/detail?id=355103
           *
           * To avoid this issue, use the keypress event as if no `textInput`
           * event is available.
           */
          var which = nativeEvent.which;
          if (which !== SPACEBAR_CODE) {
            return;
          }

          hasSpaceKeypress = true;
          chars = SPACEBAR_CHAR;
          break;

        case topLevelTypes.topTextInput:
          // Record the characters to be added to the DOM.
          chars = nativeEvent.data;

          // If it's a spacebar character, assume that we have already handled
          // it at the keypress level and bail immediately. Android Chrome
          // doesn't give us keycodes, so we need to blacklist it.
          if (chars === SPACEBAR_CHAR && hasSpaceKeypress) {
            return;
          }

          // Otherwise, carry on.
          break;

        default:
          // For other native event types, do nothing.
          return;
      }
    } else {
      switch (topLevelType) {
        case topLevelTypes.topPaste:
          // If a paste event occurs after a keypress, throw out the input
          // chars. Paste events should not lead to BeforeInput events.
          fallbackChars = null;
          break;
        case topLevelTypes.topKeyPress:
          /**
           * As of v27, Firefox may fire keypress events even when no character
           * will be inserted. A few possibilities:
           *
           * - `which` is `0`. Arrow keys, Esc key, etc.
           *
           * - `which` is the pressed key code, but no char is available.
           *   Ex: 'AltGr + d` in Polish. There is no modified character for
           *   this key combination and no character is inserted into the
           *   document, but FF fires the keypress for char code `100` anyway.
           *   No `input` event will occur.
           *
           * - `which` is the pressed key code, but a command combination is
           *   being used. Ex: `Cmd+C`. No character is inserted, and no
           *   `input` event will occur.
           */
          if (nativeEvent.which && !isKeypressCommand(nativeEvent)) {
            fallbackChars = String.fromCharCode(nativeEvent.which);
          }
          break;
        case topLevelTypes.topCompositionEnd:
          fallbackChars = nativeEvent.data;
          break;
      }

      // If no changes have occurred to the fallback string, no relevant
      // event has fired and we're done.
      if (fallbackChars === null) {
        return;
      }

      chars = fallbackChars;
    }

    // If no characters are being inserted, no BeforeInput event should
    // be fired.
    if (!chars) {
      return;
    }

    var event = SyntheticInputEvent.getPooled(
      eventTypes.beforeInput,
      topLevelTargetID,
      nativeEvent
    );

    event.data = chars;
    fallbackChars = null;
    EventPropagators.accumulateTwoPhaseDispatches(event);
    return event;
  }
};

module.exports = BeforeInputEventPlugin;

},{"./EventConstants":15,"./EventPropagators":20,"./ExecutionEnvironment":21,"./SyntheticInputEvent":89,"./keyOf":133}],3:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule CSSProperty
 */

"use strict";

/**
 * CSS properties which accept numbers but are not in units of "px".
 */
var isUnitlessNumber = {
  columnCount: true,
  fillOpacity: true,
  flex: true,
  flexGrow: true,
  flexShrink: true,
  fontWeight: true,
  lineClamp: true,
  lineHeight: true,
  opacity: true,
  order: true,
  orphans: true,
  widows: true,
  zIndex: true,
  zoom: true
};

/**
 * @param {string} prefix vendor-specific prefix, eg: Webkit
 * @param {string} key style name, eg: transitionDuration
 * @return {string} style name prefixed with `prefix`, properly camelCased, eg:
 * WebkitTransitionDuration
 */
function prefixKey(prefix, key) {
  return prefix + key.charAt(0).toUpperCase() + key.substring(1);
}

/**
 * Support style names that may come passed in prefixed by adding permutations
 * of vendor prefixes.
 */
var prefixes = ['Webkit', 'ms', 'Moz', 'O'];

// Using Object.keys here, or else the vanilla for-in loop makes IE8 go into an
// infinite loop, because it iterates over the newly added props too.
Object.keys(isUnitlessNumber).forEach(function(prop) {
  prefixes.forEach(function(prefix) {
    isUnitlessNumber[prefixKey(prefix, prop)] = isUnitlessNumber[prop];
  });
});

/**
 * Most style properties can be unset by doing .style[prop] = '' but IE8
 * doesn't like doing that with shorthand properties so for the properties that
 * IE8 breaks on, which are listed here, we instead unset each of the
 * individual properties. See http://bugs.jquery.com/ticket/12385.
 * The 4-value 'clock' properties like margin, padding, border-width seem to
 * behave without any problems. Curiously, list-style works too without any
 * special prodding.
 */
var shorthandPropertyExpansions = {
  background: {
    backgroundImage: true,
    backgroundPosition: true,
    backgroundRepeat: true,
    backgroundColor: true
  },
  border: {
    borderWidth: true,
    borderStyle: true,
    borderColor: true
  },
  borderBottom: {
    borderBottomWidth: true,
    borderBottomStyle: true,
    borderBottomColor: true
  },
  borderLeft: {
    borderLeftWidth: true,
    borderLeftStyle: true,
    borderLeftColor: true
  },
  borderRight: {
    borderRightWidth: true,
    borderRightStyle: true,
    borderRightColor: true
  },
  borderTop: {
    borderTopWidth: true,
    borderTopStyle: true,
    borderTopColor: true
  },
  font: {
    fontStyle: true,
    fontVariant: true,
    fontWeight: true,
    fontSize: true,
    lineHeight: true,
    fontFamily: true
  }
};

var CSSProperty = {
  isUnitlessNumber: isUnitlessNumber,
  shorthandPropertyExpansions: shorthandPropertyExpansions
};

module.exports = CSSProperty;

},{}],4:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule CSSPropertyOperations
 * @typechecks static-only
 */

"use strict";

var CSSProperty = require("./CSSProperty");
var ExecutionEnvironment = require("./ExecutionEnvironment");

var camelizeStyleName = require("./camelizeStyleName");
var dangerousStyleValue = require("./dangerousStyleValue");
var hyphenateStyleName = require("./hyphenateStyleName");
var memoizeStringOnly = require("./memoizeStringOnly");
var warning = require("./warning");

var processStyleName = memoizeStringOnly(function(styleName) {
  return hyphenateStyleName(styleName);
});

var styleFloatAccessor = 'cssFloat';
if (ExecutionEnvironment.canUseDOM) {
  // IE8 only supports accessing cssFloat (standard) as styleFloat
  if (document.documentElement.style.cssFloat === undefined) {
    styleFloatAccessor = 'styleFloat';
  }
}

if ("production" !== process.env.NODE_ENV) {
  var warnedStyleNames = {};

  var warnHyphenatedStyleName = function(name) {
    if (warnedStyleNames.hasOwnProperty(name) && warnedStyleNames[name]) {
      return;
    }

    warnedStyleNames[name] = true;
    ("production" !== process.env.NODE_ENV ? warning(
      false,
      'Unsupported style property ' + name + '. Did you mean ' +
      camelizeStyleName(name) + '?'
    ) : null);
  };
}

/**
 * Operations for dealing with CSS properties.
 */
var CSSPropertyOperations = {

  /**
   * Serializes a mapping of style properties for use as inline styles:
   *
   *   > createMarkupForStyles({width: '200px', height: 0})
   *   "width:200px;height:0;"
   *
   * Undefined values are ignored so that declarative programming is easier.
   * The result should be HTML-escaped before insertion into the DOM.
   *
   * @param {object} styles
   * @return {?string}
   */
  createMarkupForStyles: function(styles) {
    var serialized = '';
    for (var styleName in styles) {
      if (!styles.hasOwnProperty(styleName)) {
        continue;
      }
      if ("production" !== process.env.NODE_ENV) {
        if (styleName.indexOf('-') > -1) {
          warnHyphenatedStyleName(styleName);
        }
      }
      var styleValue = styles[styleName];
      if (styleValue != null) {
        serialized += processStyleName(styleName) + ':';
        serialized += dangerousStyleValue(styleName, styleValue) + ';';
      }
    }
    return serialized || null;
  },

  /**
   * Sets the value for multiple styles on a node.  If a value is specified as
   * '' (empty string), the corresponding style property will be unset.
   *
   * @param {DOMElement} node
   * @param {object} styles
   */
  setValueForStyles: function(node, styles) {
    var style = node.style;
    for (var styleName in styles) {
      if (!styles.hasOwnProperty(styleName)) {
        continue;
      }
      if ("production" !== process.env.NODE_ENV) {
        if (styleName.indexOf('-') > -1) {
          warnHyphenatedStyleName(styleName);
        }
      }
      var styleValue = dangerousStyleValue(styleName, styles[styleName]);
      if (styleName === 'float') {
        styleName = styleFloatAccessor;
      }
      if (styleValue) {
        style[styleName] = styleValue;
      } else {
        var expansion = CSSProperty.shorthandPropertyExpansions[styleName];
        if (expansion) {
          // Shorthand property that IE8 won't like unsetting, so unset each
          // component to placate it
          for (var individualStyleName in expansion) {
            style[individualStyleName] = '';
          }
        } else {
          style[styleName] = '';
        }
      }
    }
  }

};

module.exports = CSSPropertyOperations;

}).call(this,require('_process'))
},{"./CSSProperty":3,"./ExecutionEnvironment":21,"./camelizeStyleName":100,"./dangerousStyleValue":105,"./hyphenateStyleName":124,"./memoizeStringOnly":135,"./warning":145,"_process":152}],5:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule CallbackQueue
 */

"use strict";

var PooledClass = require("./PooledClass");

var assign = require("./Object.assign");
var invariant = require("./invariant");

/**
 * A specialized pseudo-event module to help keep track of components waiting to
 * be notified when their DOM representations are available for use.
 *
 * This implements `PooledClass`, so you should never need to instantiate this.
 * Instead, use `CallbackQueue.getPooled()`.
 *
 * @class ReactMountReady
 * @implements PooledClass
 * @internal
 */
function CallbackQueue() {
  this._callbacks = null;
  this._contexts = null;
}

assign(CallbackQueue.prototype, {

  /**
   * Enqueues a callback to be invoked when `notifyAll` is invoked.
   *
   * @param {function} callback Invoked when `notifyAll` is invoked.
   * @param {?object} context Context to call `callback` with.
   * @internal
   */
  enqueue: function(callback, context) {
    this._callbacks = this._callbacks || [];
    this._contexts = this._contexts || [];
    this._callbacks.push(callback);
    this._contexts.push(context);
  },

  /**
   * Invokes all enqueued callbacks and clears the queue. This is invoked after
   * the DOM representation of a component has been created or updated.
   *
   * @internal
   */
  notifyAll: function() {
    var callbacks = this._callbacks;
    var contexts = this._contexts;
    if (callbacks) {
      ("production" !== process.env.NODE_ENV ? invariant(
        callbacks.length === contexts.length,
        "Mismatched list of contexts in callback queue"
      ) : invariant(callbacks.length === contexts.length));
      this._callbacks = null;
      this._contexts = null;
      for (var i = 0, l = callbacks.length; i < l; i++) {
        callbacks[i].call(contexts[i]);
      }
      callbacks.length = 0;
      contexts.length = 0;
    }
  },

  /**
   * Resets the internal queue.
   *
   * @internal
   */
  reset: function() {
    this._callbacks = null;
    this._contexts = null;
  },

  /**
   * `PooledClass` looks for this.
   */
  destructor: function() {
    this.reset();
  }

});

PooledClass.addPoolingTo(CallbackQueue);

module.exports = CallbackQueue;

}).call(this,require('_process'))
},{"./Object.assign":26,"./PooledClass":27,"./invariant":126,"_process":152}],6:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ChangeEventPlugin
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPluginHub = require("./EventPluginHub");
var EventPropagators = require("./EventPropagators");
var ExecutionEnvironment = require("./ExecutionEnvironment");
var ReactUpdates = require("./ReactUpdates");
var SyntheticEvent = require("./SyntheticEvent");

var isEventSupported = require("./isEventSupported");
var isTextInputElement = require("./isTextInputElement");
var keyOf = require("./keyOf");

var topLevelTypes = EventConstants.topLevelTypes;

var eventTypes = {
  change: {
    phasedRegistrationNames: {
      bubbled: keyOf({onChange: null}),
      captured: keyOf({onChangeCapture: null})
    },
    dependencies: [
      topLevelTypes.topBlur,
      topLevelTypes.topChange,
      topLevelTypes.topClick,
      topLevelTypes.topFocus,
      topLevelTypes.topInput,
      topLevelTypes.topKeyDown,
      topLevelTypes.topKeyUp,
      topLevelTypes.topSelectionChange
    ]
  }
};

/**
 * For IE shims
 */
var activeElement = null;
var activeElementID = null;
var activeElementValue = null;
var activeElementValueProp = null;

/**
 * SECTION: handle `change` event
 */
function shouldUseChangeEvent(elem) {
  return (
    elem.nodeName === 'SELECT' ||
    (elem.nodeName === 'INPUT' && elem.type === 'file')
  );
}

var doesChangeEventBubble = false;
if (ExecutionEnvironment.canUseDOM) {
  // See `handleChange` comment below
  doesChangeEventBubble = isEventSupported('change') && (
    !('documentMode' in document) || document.documentMode > 8
  );
}

function manualDispatchChangeEvent(nativeEvent) {
  var event = SyntheticEvent.getPooled(
    eventTypes.change,
    activeElementID,
    nativeEvent
  );
  EventPropagators.accumulateTwoPhaseDispatches(event);

  // If change and propertychange bubbled, we'd just bind to it like all the
  // other events and have it go through ReactBrowserEventEmitter. Since it
  // doesn't, we manually listen for the events and so we have to enqueue and
  // process the abstract event manually.
  //
  // Batching is necessary here in order to ensure that all event handlers run
  // before the next rerender (including event handlers attached to ancestor
  // elements instead of directly on the input). Without this, controlled
  // components don't work properly in conjunction with event bubbling because
  // the component is rerendered and the value reverted before all the event
  // handlers can run. See https://github.com/facebook/react/issues/708.
  ReactUpdates.batchedUpdates(runEventInBatch, event);
}

function runEventInBatch(event) {
  EventPluginHub.enqueueEvents(event);
  EventPluginHub.processEventQueue();
}

function startWatchingForChangeEventIE8(target, targetID) {
  activeElement = target;
  activeElementID = targetID;
  activeElement.attachEvent('onchange', manualDispatchChangeEvent);
}

function stopWatchingForChangeEventIE8() {
  if (!activeElement) {
    return;
  }
  activeElement.detachEvent('onchange', manualDispatchChangeEvent);
  activeElement = null;
  activeElementID = null;
}

function getTargetIDForChangeEvent(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topChange) {
    return topLevelTargetID;
  }
}
function handleEventsForChangeEventIE8(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topFocus) {
    // stopWatching() should be a noop here but we call it just in case we
    // missed a blur event somehow.
    stopWatchingForChangeEventIE8();
    startWatchingForChangeEventIE8(topLevelTarget, topLevelTargetID);
  } else if (topLevelType === topLevelTypes.topBlur) {
    stopWatchingForChangeEventIE8();
  }
}


/**
 * SECTION: handle `input` event
 */
var isInputEventSupported = false;
if (ExecutionEnvironment.canUseDOM) {
  // IE9 claims to support the input event but fails to trigger it when
  // deleting text, so we ignore its input events
  isInputEventSupported = isEventSupported('input') && (
    !('documentMode' in document) || document.documentMode > 9
  );
}

/**
 * (For old IE.) Replacement getter/setter for the `value` property that gets
 * set on the active element.
 */
var newValueProp =  {
  get: function() {
    return activeElementValueProp.get.call(this);
  },
  set: function(val) {
    // Cast to a string so we can do equality checks.
    activeElementValue = '' + val;
    activeElementValueProp.set.call(this, val);
  }
};

/**
 * (For old IE.) Starts tracking propertychange events on the passed-in element
 * and override the value property so that we can distinguish user events from
 * value changes in JS.
 */
function startWatchingForValueChange(target, targetID) {
  activeElement = target;
  activeElementID = targetID;
  activeElementValue = target.value;
  activeElementValueProp = Object.getOwnPropertyDescriptor(
    target.constructor.prototype,
    'value'
  );

  Object.defineProperty(activeElement, 'value', newValueProp);
  activeElement.attachEvent('onpropertychange', handlePropertyChange);
}

/**
 * (For old IE.) Removes the event listeners from the currently-tracked element,
 * if any exists.
 */
function stopWatchingForValueChange() {
  if (!activeElement) {
    return;
  }

  // delete restores the original property definition
  delete activeElement.value;
  activeElement.detachEvent('onpropertychange', handlePropertyChange);

  activeElement = null;
  activeElementID = null;
  activeElementValue = null;
  activeElementValueProp = null;
}

/**
 * (For old IE.) Handles a propertychange event, sending a `change` event if
 * the value of the active element has changed.
 */
function handlePropertyChange(nativeEvent) {
  if (nativeEvent.propertyName !== 'value') {
    return;
  }
  var value = nativeEvent.srcElement.value;
  if (value === activeElementValue) {
    return;
  }
  activeElementValue = value;

  manualDispatchChangeEvent(nativeEvent);
}

/**
 * If a `change` event should be fired, returns the target's ID.
 */
function getTargetIDForInputEvent(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topInput) {
    // In modern browsers (i.e., not IE8 or IE9), the input event is exactly
    // what we want so fall through here and trigger an abstract event
    return topLevelTargetID;
  }
}

// For IE8 and IE9.
function handleEventsForInputEventIE(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topFocus) {
    // In IE8, we can capture almost all .value changes by adding a
    // propertychange handler and looking for events with propertyName
    // equal to 'value'
    // In IE9, propertychange fires for most input events but is buggy and
    // doesn't fire when text is deleted, but conveniently, selectionchange
    // appears to fire in all of the remaining cases so we catch those and
    // forward the event if the value has changed
    // In either case, we don't want to call the event handler if the value
    // is changed from JS so we redefine a setter for `.value` that updates
    // our activeElementValue variable, allowing us to ignore those changes
    //
    // stopWatching() should be a noop here but we call it just in case we
    // missed a blur event somehow.
    stopWatchingForValueChange();
    startWatchingForValueChange(topLevelTarget, topLevelTargetID);
  } else if (topLevelType === topLevelTypes.topBlur) {
    stopWatchingForValueChange();
  }
}

// For IE8 and IE9.
function getTargetIDForInputEventIE(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topSelectionChange ||
      topLevelType === topLevelTypes.topKeyUp ||
      topLevelType === topLevelTypes.topKeyDown) {
    // On the selectionchange event, the target is just document which isn't
    // helpful for us so just check activeElement instead.
    //
    // 99% of the time, keydown and keyup aren't necessary. IE8 fails to fire
    // propertychange on the first input event after setting `value` from a
    // script and fires only keydown, keypress, keyup. Catching keyup usually
    // gets it and catching keydown lets us fire an event for the first
    // keystroke if user does a key repeat (it'll be a little delayed: right
    // before the second keystroke). Other input methods (e.g., paste) seem to
    // fire selectionchange normally.
    if (activeElement && activeElement.value !== activeElementValue) {
      activeElementValue = activeElement.value;
      return activeElementID;
    }
  }
}


/**
 * SECTION: handle `click` event
 */
function shouldUseClickEvent(elem) {
  // Use the `click` event to detect changes to checkbox and radio inputs.
  // This approach works across all browsers, whereas `change` does not fire
  // until `blur` in IE8.
  return (
    elem.nodeName === 'INPUT' &&
    (elem.type === 'checkbox' || elem.type === 'radio')
  );
}

function getTargetIDForClickEvent(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topClick) {
    return topLevelTargetID;
  }
}

/**
 * This plugin creates an `onChange` event that normalizes change events
 * across form elements. This event fires at a time when it's possible to
 * change the element's value without seeing a flicker.
 *
 * Supported elements are:
 * - input (see `isTextInputElement`)
 * - textarea
 * - select
 */
var ChangeEventPlugin = {

  eventTypes: eventTypes,

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {

    var getTargetIDFunc, handleEventFunc;
    if (shouldUseChangeEvent(topLevelTarget)) {
      if (doesChangeEventBubble) {
        getTargetIDFunc = getTargetIDForChangeEvent;
      } else {
        handleEventFunc = handleEventsForChangeEventIE8;
      }
    } else if (isTextInputElement(topLevelTarget)) {
      if (isInputEventSupported) {
        getTargetIDFunc = getTargetIDForInputEvent;
      } else {
        getTargetIDFunc = getTargetIDForInputEventIE;
        handleEventFunc = handleEventsForInputEventIE;
      }
    } else if (shouldUseClickEvent(topLevelTarget)) {
      getTargetIDFunc = getTargetIDForClickEvent;
    }

    if (getTargetIDFunc) {
      var targetID = getTargetIDFunc(
        topLevelType,
        topLevelTarget,
        topLevelTargetID
      );
      if (targetID) {
        var event = SyntheticEvent.getPooled(
          eventTypes.change,
          targetID,
          nativeEvent
        );
        EventPropagators.accumulateTwoPhaseDispatches(event);
        return event;
      }
    }

    if (handleEventFunc) {
      handleEventFunc(
        topLevelType,
        topLevelTarget,
        topLevelTargetID
      );
    }
  }

};

module.exports = ChangeEventPlugin;

},{"./EventConstants":15,"./EventPluginHub":17,"./EventPropagators":20,"./ExecutionEnvironment":21,"./ReactUpdates":79,"./SyntheticEvent":87,"./isEventSupported":127,"./isTextInputElement":129,"./keyOf":133}],7:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ClientReactRootIndex
 * @typechecks
 */

"use strict";

var nextReactRootIndex = 0;

var ClientReactRootIndex = {
  createReactRootIndex: function() {
    return nextReactRootIndex++;
  }
};

module.exports = ClientReactRootIndex;

},{}],8:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule CompositionEventPlugin
 * @typechecks static-only
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPropagators = require("./EventPropagators");
var ExecutionEnvironment = require("./ExecutionEnvironment");
var ReactInputSelection = require("./ReactInputSelection");
var SyntheticCompositionEvent = require("./SyntheticCompositionEvent");

var getTextContentAccessor = require("./getTextContentAccessor");
var keyOf = require("./keyOf");

var END_KEYCODES = [9, 13, 27, 32]; // Tab, Return, Esc, Space
var START_KEYCODE = 229;

var useCompositionEvent = (
  ExecutionEnvironment.canUseDOM &&
  'CompositionEvent' in window
);

// In IE9+, we have access to composition events, but the data supplied
// by the native compositionend event may be incorrect. In Korean, for example,
// the compositionend event contains only one character regardless of
// how many characters have been composed since compositionstart.
// We therefore use the fallback data while still using the native
// events as triggers.
var useFallbackData = (
  !useCompositionEvent ||
  (
    'documentMode' in document &&
    document.documentMode > 8 &&
    document.documentMode <= 11
  )
);

var topLevelTypes = EventConstants.topLevelTypes;
var currentComposition = null;

// Events and their corresponding property names.
var eventTypes = {
  compositionEnd: {
    phasedRegistrationNames: {
      bubbled: keyOf({onCompositionEnd: null}),
      captured: keyOf({onCompositionEndCapture: null})
    },
    dependencies: [
      topLevelTypes.topBlur,
      topLevelTypes.topCompositionEnd,
      topLevelTypes.topKeyDown,
      topLevelTypes.topKeyPress,
      topLevelTypes.topKeyUp,
      topLevelTypes.topMouseDown
    ]
  },
  compositionStart: {
    phasedRegistrationNames: {
      bubbled: keyOf({onCompositionStart: null}),
      captured: keyOf({onCompositionStartCapture: null})
    },
    dependencies: [
      topLevelTypes.topBlur,
      topLevelTypes.topCompositionStart,
      topLevelTypes.topKeyDown,
      topLevelTypes.topKeyPress,
      topLevelTypes.topKeyUp,
      topLevelTypes.topMouseDown
    ]
  },
  compositionUpdate: {
    phasedRegistrationNames: {
      bubbled: keyOf({onCompositionUpdate: null}),
      captured: keyOf({onCompositionUpdateCapture: null})
    },
    dependencies: [
      topLevelTypes.topBlur,
      topLevelTypes.topCompositionUpdate,
      topLevelTypes.topKeyDown,
      topLevelTypes.topKeyPress,
      topLevelTypes.topKeyUp,
      topLevelTypes.topMouseDown
    ]
  }
};

/**
 * Translate native top level events into event types.
 *
 * @param {string} topLevelType
 * @return {object}
 */
function getCompositionEventType(topLevelType) {
  switch (topLevelType) {
    case topLevelTypes.topCompositionStart:
      return eventTypes.compositionStart;
    case topLevelTypes.topCompositionEnd:
      return eventTypes.compositionEnd;
    case topLevelTypes.topCompositionUpdate:
      return eventTypes.compositionUpdate;
  }
}

/**
 * Does our fallback best-guess model think this event signifies that
 * composition has begun?
 *
 * @param {string} topLevelType
 * @param {object} nativeEvent
 * @return {boolean}
 */
function isFallbackStart(topLevelType, nativeEvent) {
  return (
    topLevelType === topLevelTypes.topKeyDown &&
    nativeEvent.keyCode === START_KEYCODE
  );
}

/**
 * Does our fallback mode think that this event is the end of composition?
 *
 * @param {string} topLevelType
 * @param {object} nativeEvent
 * @return {boolean}
 */
function isFallbackEnd(topLevelType, nativeEvent) {
  switch (topLevelType) {
    case topLevelTypes.topKeyUp:
      // Command keys insert or clear IME input.
      return (END_KEYCODES.indexOf(nativeEvent.keyCode) !== -1);
    case topLevelTypes.topKeyDown:
      // Expect IME keyCode on each keydown. If we get any other
      // code we must have exited earlier.
      return (nativeEvent.keyCode !== START_KEYCODE);
    case topLevelTypes.topKeyPress:
    case topLevelTypes.topMouseDown:
    case topLevelTypes.topBlur:
      // Events are not possible without cancelling IME.
      return true;
    default:
      return false;
  }
}

/**
 * Helper class stores information about selection and document state
 * so we can figure out what changed at a later date.
 *
 * @param {DOMEventTarget} root
 */
function FallbackCompositionState(root) {
  this.root = root;
  this.startSelection = ReactInputSelection.getSelection(root);
  this.startValue = this.getText();
}

/**
 * Get current text of input.
 *
 * @return {string}
 */
FallbackCompositionState.prototype.getText = function() {
  return this.root.value || this.root[getTextContentAccessor()];
};

/**
 * Text that has changed since the start of composition.
 *
 * @return {string}
 */
FallbackCompositionState.prototype.getData = function() {
  var endValue = this.getText();
  var prefixLength = this.startSelection.start;
  var suffixLength = this.startValue.length - this.startSelection.end;

  return endValue.substr(
    prefixLength,
    endValue.length - suffixLength - prefixLength
  );
};

/**
 * This plugin creates `onCompositionStart`, `onCompositionUpdate` and
 * `onCompositionEnd` events on inputs, textareas and contentEditable
 * nodes.
 */
var CompositionEventPlugin = {

  eventTypes: eventTypes,

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {

    var eventType;
    var data;

    if (useCompositionEvent) {
      eventType = getCompositionEventType(topLevelType);
    } else if (!currentComposition) {
      if (isFallbackStart(topLevelType, nativeEvent)) {
        eventType = eventTypes.compositionStart;
      }
    } else if (isFallbackEnd(topLevelType, nativeEvent)) {
      eventType = eventTypes.compositionEnd;
    }

    if (useFallbackData) {
      // The current composition is stored statically and must not be
      // overwritten while composition continues.
      if (!currentComposition && eventType === eventTypes.compositionStart) {
        currentComposition = new FallbackCompositionState(topLevelTarget);
      } else if (eventType === eventTypes.compositionEnd) {
        if (currentComposition) {
          data = currentComposition.getData();
          currentComposition = null;
        }
      }
    }

    if (eventType) {
      var event = SyntheticCompositionEvent.getPooled(
        eventType,
        topLevelTargetID,
        nativeEvent
      );
      if (data) {
        // Inject data generated from fallback path into the synthetic event.
        // This matches the property of native CompositionEventInterface.
        event.data = data;
      }
      EventPropagators.accumulateTwoPhaseDispatches(event);
      return event;
    }
  }
};

module.exports = CompositionEventPlugin;

},{"./EventConstants":15,"./EventPropagators":20,"./ExecutionEnvironment":21,"./ReactInputSelection":59,"./SyntheticCompositionEvent":85,"./getTextContentAccessor":121,"./keyOf":133}],9:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule DOMChildrenOperations
 * @typechecks static-only
 */

"use strict";

var Danger = require("./Danger");
var ReactMultiChildUpdateTypes = require("./ReactMultiChildUpdateTypes");

var getTextContentAccessor = require("./getTextContentAccessor");
var invariant = require("./invariant");

/**
 * The DOM property to use when setting text content.
 *
 * @type {string}
 * @private
 */
var textContentAccessor = getTextContentAccessor();

/**
 * Inserts `childNode` as a child of `parentNode` at the `index`.
 *
 * @param {DOMElement} parentNode Parent node in which to insert.
 * @param {DOMElement} childNode Child node to insert.
 * @param {number} index Index at which to insert the child.
 * @internal
 */
function insertChildAt(parentNode, childNode, index) {
  // By exploiting arrays returning `undefined` for an undefined index, we can
  // rely exclusively on `insertBefore(node, null)` instead of also using
  // `appendChild(node)`. However, using `undefined` is not allowed by all
  // browsers so we must replace it with `null`.
  parentNode.insertBefore(
    childNode,
    parentNode.childNodes[index] || null
  );
}

var updateTextContent;
if (textContentAccessor === 'textContent') {
  /**
   * Sets the text content of `node` to `text`.
   *
   * @param {DOMElement} node Node to change
   * @param {string} text New text content
   */
  updateTextContent = function(node, text) {
    node.textContent = text;
  };
} else {
  /**
   * Sets the text content of `node` to `text`.
   *
   * @param {DOMElement} node Node to change
   * @param {string} text New text content
   */
  updateTextContent = function(node, text) {
    // In order to preserve newlines correctly, we can't use .innerText to set
    // the contents (see #1080), so we empty the element then append a text node
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
    if (text) {
      var doc = node.ownerDocument || document;
      node.appendChild(doc.createTextNode(text));
    }
  };
}

/**
 * Operations for updating with DOM children.
 */
var DOMChildrenOperations = {

  dangerouslyReplaceNodeWithMarkup: Danger.dangerouslyReplaceNodeWithMarkup,

  updateTextContent: updateTextContent,

  /**
   * Updates a component's children by processing a series of updates. The
   * update configurations are each expected to have a `parentNode` property.
   *
   * @param {array<object>} updates List of update configurations.
   * @param {array<string>} markupList List of markup strings.
   * @internal
   */
  processUpdates: function(updates, markupList) {
    var update;
    // Mapping from parent IDs to initial child orderings.
    var initialChildren = null;
    // List of children that will be moved or removed.
    var updatedChildren = null;

    for (var i = 0; update = updates[i]; i++) {
      if (update.type === ReactMultiChildUpdateTypes.MOVE_EXISTING ||
          update.type === ReactMultiChildUpdateTypes.REMOVE_NODE) {
        var updatedIndex = update.fromIndex;
        var updatedChild = update.parentNode.childNodes[updatedIndex];
        var parentID = update.parentID;

        ("production" !== process.env.NODE_ENV ? invariant(
          updatedChild,
          'processUpdates(): Unable to find child %s of element. This ' +
          'probably means the DOM was unexpectedly mutated (e.g., by the ' +
          'browser), usually due to forgetting a <tbody> when using tables, ' +
          'nesting tags like <form>, <p>, or <a>, or using non-SVG elements '+
          'in an <svg> parent. Try inspecting the child nodes of the element ' +
          'with React ID `%s`.',
          updatedIndex,
          parentID
        ) : invariant(updatedChild));

        initialChildren = initialChildren || {};
        initialChildren[parentID] = initialChildren[parentID] || [];
        initialChildren[parentID][updatedIndex] = updatedChild;

        updatedChildren = updatedChildren || [];
        updatedChildren.push(updatedChild);
      }
    }

    var renderedMarkup = Danger.dangerouslyRenderMarkup(markupList);

    // Remove updated children first so that `toIndex` is consistent.
    if (updatedChildren) {
      for (var j = 0; j < updatedChildren.length; j++) {
        updatedChildren[j].parentNode.removeChild(updatedChildren[j]);
      }
    }

    for (var k = 0; update = updates[k]; k++) {
      switch (update.type) {
        case ReactMultiChildUpdateTypes.INSERT_MARKUP:
          insertChildAt(
            update.parentNode,
            renderedMarkup[update.markupIndex],
            update.toIndex
          );
          break;
        case ReactMultiChildUpdateTypes.MOVE_EXISTING:
          insertChildAt(
            update.parentNode,
            initialChildren[update.parentID][update.fromIndex],
            update.toIndex
          );
          break;
        case ReactMultiChildUpdateTypes.TEXT_CONTENT:
          updateTextContent(
            update.parentNode,
            update.textContent
          );
          break;
        case ReactMultiChildUpdateTypes.REMOVE_NODE:
          // Already removed by the for-loop above.
          break;
      }
    }
  }

};

module.exports = DOMChildrenOperations;

}).call(this,require('_process'))
},{"./Danger":12,"./ReactMultiChildUpdateTypes":65,"./getTextContentAccessor":121,"./invariant":126,"_process":152}],10:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule DOMProperty
 * @typechecks static-only
 */

/*jslint bitwise: true */

"use strict";

var invariant = require("./invariant");

function checkMask(value, bitmask) {
  return (value & bitmask) === bitmask;
}

var DOMPropertyInjection = {
  /**
   * Mapping from normalized, camelcased property names to a configuration that
   * specifies how the associated DOM property should be accessed or rendered.
   */
  MUST_USE_ATTRIBUTE: 0x1,
  MUST_USE_PROPERTY: 0x2,
  HAS_SIDE_EFFECTS: 0x4,
  HAS_BOOLEAN_VALUE: 0x8,
  HAS_NUMERIC_VALUE: 0x10,
  HAS_POSITIVE_NUMERIC_VALUE: 0x20 | 0x10,
  HAS_OVERLOADED_BOOLEAN_VALUE: 0x40,

  /**
   * Inject some specialized knowledge about the DOM. This takes a config object
   * with the following properties:
   *
   * isCustomAttribute: function that given an attribute name will return true
   * if it can be inserted into the DOM verbatim. Useful for data-* or aria-*
   * attributes where it's impossible to enumerate all of the possible
   * attribute names,
   *
   * Properties: object mapping DOM property name to one of the
   * DOMPropertyInjection constants or null. If your attribute isn't in here,
   * it won't get written to the DOM.
   *
   * DOMAttributeNames: object mapping React attribute name to the DOM
   * attribute name. Attribute names not specified use the **lowercase**
   * normalized name.
   *
   * DOMPropertyNames: similar to DOMAttributeNames but for DOM properties.
   * Property names not specified use the normalized name.
   *
   * DOMMutationMethods: Properties that require special mutation methods. If
   * `value` is undefined, the mutation method should unset the property.
   *
   * @param {object} domPropertyConfig the config as described above.
   */
  injectDOMPropertyConfig: function(domPropertyConfig) {
    var Properties = domPropertyConfig.Properties || {};
    var DOMAttributeNames = domPropertyConfig.DOMAttributeNames || {};
    var DOMPropertyNames = domPropertyConfig.DOMPropertyNames || {};
    var DOMMutationMethods = domPropertyConfig.DOMMutationMethods || {};

    if (domPropertyConfig.isCustomAttribute) {
      DOMProperty._isCustomAttributeFunctions.push(
        domPropertyConfig.isCustomAttribute
      );
    }

    for (var propName in Properties) {
      ("production" !== process.env.NODE_ENV ? invariant(
        !DOMProperty.isStandardName.hasOwnProperty(propName),
        'injectDOMPropertyConfig(...): You\'re trying to inject DOM property ' +
        '\'%s\' which has already been injected. You may be accidentally ' +
        'injecting the same DOM property config twice, or you may be ' +
        'injecting two configs that have conflicting property names.',
        propName
      ) : invariant(!DOMProperty.isStandardName.hasOwnProperty(propName)));

      DOMProperty.isStandardName[propName] = true;

      var lowerCased = propName.toLowerCase();
      DOMProperty.getPossibleStandardName[lowerCased] = propName;

      if (DOMAttributeNames.hasOwnProperty(propName)) {
        var attributeName = DOMAttributeNames[propName];
        DOMProperty.getPossibleStandardName[attributeName] = propName;
        DOMProperty.getAttributeName[propName] = attributeName;
      } else {
        DOMProperty.getAttributeName[propName] = lowerCased;
      }

      DOMProperty.getPropertyName[propName] =
        DOMPropertyNames.hasOwnProperty(propName) ?
          DOMPropertyNames[propName] :
          propName;

      if (DOMMutationMethods.hasOwnProperty(propName)) {
        DOMProperty.getMutationMethod[propName] = DOMMutationMethods[propName];
      } else {
        DOMProperty.getMutationMethod[propName] = null;
      }

      var propConfig = Properties[propName];
      DOMProperty.mustUseAttribute[propName] =
        checkMask(propConfig, DOMPropertyInjection.MUST_USE_ATTRIBUTE);
      DOMProperty.mustUseProperty[propName] =
        checkMask(propConfig, DOMPropertyInjection.MUST_USE_PROPERTY);
      DOMProperty.hasSideEffects[propName] =
        checkMask(propConfig, DOMPropertyInjection.HAS_SIDE_EFFECTS);
      DOMProperty.hasBooleanValue[propName] =
        checkMask(propConfig, DOMPropertyInjection.HAS_BOOLEAN_VALUE);
      DOMProperty.hasNumericValue[propName] =
        checkMask(propConfig, DOMPropertyInjection.HAS_NUMERIC_VALUE);
      DOMProperty.hasPositiveNumericValue[propName] =
        checkMask(propConfig, DOMPropertyInjection.HAS_POSITIVE_NUMERIC_VALUE);
      DOMProperty.hasOverloadedBooleanValue[propName] =
        checkMask(propConfig, DOMPropertyInjection.HAS_OVERLOADED_BOOLEAN_VALUE);

      ("production" !== process.env.NODE_ENV ? invariant(
        !DOMProperty.mustUseAttribute[propName] ||
          !DOMProperty.mustUseProperty[propName],
        'DOMProperty: Cannot require using both attribute and property: %s',
        propName
      ) : invariant(!DOMProperty.mustUseAttribute[propName] ||
        !DOMProperty.mustUseProperty[propName]));
      ("production" !== process.env.NODE_ENV ? invariant(
        DOMProperty.mustUseProperty[propName] ||
          !DOMProperty.hasSideEffects[propName],
        'DOMProperty: Properties that have side effects must use property: %s',
        propName
      ) : invariant(DOMProperty.mustUseProperty[propName] ||
        !DOMProperty.hasSideEffects[propName]));
      ("production" !== process.env.NODE_ENV ? invariant(
        !!DOMProperty.hasBooleanValue[propName] +
          !!DOMProperty.hasNumericValue[propName] +
          !!DOMProperty.hasOverloadedBooleanValue[propName] <= 1,
        'DOMProperty: Value can be one of boolean, overloaded boolean, or ' +
        'numeric value, but not a combination: %s',
        propName
      ) : invariant(!!DOMProperty.hasBooleanValue[propName] +
        !!DOMProperty.hasNumericValue[propName] +
        !!DOMProperty.hasOverloadedBooleanValue[propName] <= 1));
    }
  }
};
var defaultValueCache = {};

/**
 * DOMProperty exports lookup objects that can be used like functions:
 *
 *   > DOMProperty.isValid['id']
 *   true
 *   > DOMProperty.isValid['foobar']
 *   undefined
 *
 * Although this may be confusing, it performs better in general.
 *
 * @see http://jsperf.com/key-exists
 * @see http://jsperf.com/key-missing
 */
var DOMProperty = {

  ID_ATTRIBUTE_NAME: 'data-reactid',

  /**
   * Checks whether a property name is a standard property.
   * @type {Object}
   */
  isStandardName: {},

  /**
   * Mapping from lowercase property names to the properly cased version, used
   * to warn in the case of missing properties.
   * @type {Object}
   */
  getPossibleStandardName: {},

  /**
   * Mapping from normalized names to attribute names that differ. Attribute
   * names are used when rendering markup or with `*Attribute()`.
   * @type {Object}
   */
  getAttributeName: {},

  /**
   * Mapping from normalized names to properties on DOM node instances.
   * (This includes properties that mutate due to external factors.)
   * @type {Object}
   */
  getPropertyName: {},

  /**
   * Mapping from normalized names to mutation methods. This will only exist if
   * mutation cannot be set simply by the property or `setAttribute()`.
   * @type {Object}
   */
  getMutationMethod: {},

  /**
   * Whether the property must be accessed and mutated as an object property.
   * @type {Object}
   */
  mustUseAttribute: {},

  /**
   * Whether the property must be accessed and mutated using `*Attribute()`.
   * (This includes anything that fails `<propName> in <element>`.)
   * @type {Object}
   */
  mustUseProperty: {},

  /**
   * Whether or not setting a value causes side effects such as triggering
   * resources to be loaded or text selection changes. We must ensure that
   * the value is only set if it has changed.
   * @type {Object}
   */
  hasSideEffects: {},

  /**
   * Whether the property should be removed when set to a falsey value.
   * @type {Object}
   */
  hasBooleanValue: {},

  /**
   * Whether the property must be numeric or parse as a
   * numeric and should be removed when set to a falsey value.
   * @type {Object}
   */
  hasNumericValue: {},

  /**
   * Whether the property must be positive numeric or parse as a positive
   * numeric and should be removed when set to a falsey value.
   * @type {Object}
   */
  hasPositiveNumericValue: {},

  /**
   * Whether the property can be used as a flag as well as with a value. Removed
   * when strictly equal to false; present without a value when strictly equal
   * to true; present with a value otherwise.
   * @type {Object}
   */
  hasOverloadedBooleanValue: {},

  /**
   * All of the isCustomAttribute() functions that have been injected.
   */
  _isCustomAttributeFunctions: [],

  /**
   * Checks whether a property name is a custom attribute.
   * @method
   */
  isCustomAttribute: function(attributeName) {
    for (var i = 0; i < DOMProperty._isCustomAttributeFunctions.length; i++) {
      var isCustomAttributeFn = DOMProperty._isCustomAttributeFunctions[i];
      if (isCustomAttributeFn(attributeName)) {
        return true;
      }
    }
    return false;
  },

  /**
   * Returns the default property value for a DOM property (i.e., not an
   * attribute). Most default values are '' or false, but not all. Worse yet,
   * some (in particular, `type`) vary depending on the type of element.
   *
   * TODO: Is it better to grab all the possible properties when creating an
   * element to avoid having to create the same element twice?
   */
  getDefaultValueForProperty: function(nodeName, prop) {
    var nodeDefaults = defaultValueCache[nodeName];
    var testElement;
    if (!nodeDefaults) {
      defaultValueCache[nodeName] = nodeDefaults = {};
    }
    if (!(prop in nodeDefaults)) {
      testElement = document.createElement(nodeName);
      nodeDefaults[prop] = testElement[prop];
    }
    return nodeDefaults[prop];
  },

  injection: DOMPropertyInjection
};

module.exports = DOMProperty;

}).call(this,require('_process'))
},{"./invariant":126,"_process":152}],11:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule DOMPropertyOperations
 * @typechecks static-only
 */

"use strict";

var DOMProperty = require("./DOMProperty");

var escapeTextForBrowser = require("./escapeTextForBrowser");
var memoizeStringOnly = require("./memoizeStringOnly");
var warning = require("./warning");

function shouldIgnoreValue(name, value) {
  return value == null ||
    (DOMProperty.hasBooleanValue[name] && !value) ||
    (DOMProperty.hasNumericValue[name] && isNaN(value)) ||
    (DOMProperty.hasPositiveNumericValue[name] && (value < 1)) ||
    (DOMProperty.hasOverloadedBooleanValue[name] && value === false);
}

var processAttributeNameAndPrefix = memoizeStringOnly(function(name) {
  return escapeTextForBrowser(name) + '="';
});

if ("production" !== process.env.NODE_ENV) {
  var reactProps = {
    children: true,
    dangerouslySetInnerHTML: true,
    key: true,
    ref: true
  };
  var warnedProperties = {};

  var warnUnknownProperty = function(name) {
    if (reactProps.hasOwnProperty(name) && reactProps[name] ||
        warnedProperties.hasOwnProperty(name) && warnedProperties[name]) {
      return;
    }

    warnedProperties[name] = true;
    var lowerCasedName = name.toLowerCase();

    // data-* attributes should be lowercase; suggest the lowercase version
    var standardName = (
      DOMProperty.isCustomAttribute(lowerCasedName) ?
        lowerCasedName :
      DOMProperty.getPossibleStandardName.hasOwnProperty(lowerCasedName) ?
        DOMProperty.getPossibleStandardName[lowerCasedName] :
        null
    );

    // For now, only warn when we have a suggested correction. This prevents
    // logging too much when using transferPropsTo.
    ("production" !== process.env.NODE_ENV ? warning(
      standardName == null,
      'Unknown DOM property ' + name + '. Did you mean ' + standardName + '?'
    ) : null);

  };
}

/**
 * Operations for dealing with DOM properties.
 */
var DOMPropertyOperations = {

  /**
   * Creates markup for the ID property.
   *
   * @param {string} id Unescaped ID.
   * @return {string} Markup string.
   */
  createMarkupForID: function(id) {
    return processAttributeNameAndPrefix(DOMProperty.ID_ATTRIBUTE_NAME) +
      escapeTextForBrowser(id) + '"';
  },

  /**
   * Creates markup for a property.
   *
   * @param {string} name
   * @param {*} value
   * @return {?string} Markup string, or null if the property was invalid.
   */
  createMarkupForProperty: function(name, value) {
    if (DOMProperty.isStandardName.hasOwnProperty(name) &&
        DOMProperty.isStandardName[name]) {
      if (shouldIgnoreValue(name, value)) {
        return '';
      }
      var attributeName = DOMProperty.getAttributeName[name];
      if (DOMProperty.hasBooleanValue[name] ||
          (DOMProperty.hasOverloadedBooleanValue[name] && value === true)) {
        return escapeTextForBrowser(attributeName);
      }
      return processAttributeNameAndPrefix(attributeName) +
        escapeTextForBrowser(value) + '"';
    } else if (DOMProperty.isCustomAttribute(name)) {
      if (value == null) {
        return '';
      }
      return processAttributeNameAndPrefix(name) +
        escapeTextForBrowser(value) + '"';
    } else if ("production" !== process.env.NODE_ENV) {
      warnUnknownProperty(name);
    }
    return null;
  },

  /**
   * Sets the value for a property on a node.
   *
   * @param {DOMElement} node
   * @param {string} name
   * @param {*} value
   */
  setValueForProperty: function(node, name, value) {
    if (DOMProperty.isStandardName.hasOwnProperty(name) &&
        DOMProperty.isStandardName[name]) {
      var mutationMethod = DOMProperty.getMutationMethod[name];
      if (mutationMethod) {
        mutationMethod(node, value);
      } else if (shouldIgnoreValue(name, value)) {
        this.deleteValueForProperty(node, name);
      } else if (DOMProperty.mustUseAttribute[name]) {
        // `setAttribute` with objects becomes only `[object]` in IE8/9,
        // ('' + value) makes it output the correct toString()-value.
        node.setAttribute(DOMProperty.getAttributeName[name], '' + value);
      } else {
        var propName = DOMProperty.getPropertyName[name];
        // Must explicitly cast values for HAS_SIDE_EFFECTS-properties to the
        // property type before comparing; only `value` does and is string.
        if (!DOMProperty.hasSideEffects[name] ||
            ('' + node[propName]) !== ('' + value)) {
          // Contrary to `setAttribute`, object properties are properly
          // `toString`ed by IE8/9.
          node[propName] = value;
        }
      }
    } else if (DOMProperty.isCustomAttribute(name)) {
      if (value == null) {
        node.removeAttribute(name);
      } else {
        node.setAttribute(name, '' + value);
      }
    } else if ("production" !== process.env.NODE_ENV) {
      warnUnknownProperty(name);
    }
  },

  /**
   * Deletes the value for a property on a node.
   *
   * @param {DOMElement} node
   * @param {string} name
   */
  deleteValueForProperty: function(node, name) {
    if (DOMProperty.isStandardName.hasOwnProperty(name) &&
        DOMProperty.isStandardName[name]) {
      var mutationMethod = DOMProperty.getMutationMethod[name];
      if (mutationMethod) {
        mutationMethod(node, undefined);
      } else if (DOMProperty.mustUseAttribute[name]) {
        node.removeAttribute(DOMProperty.getAttributeName[name]);
      } else {
        var propName = DOMProperty.getPropertyName[name];
        var defaultValue = DOMProperty.getDefaultValueForProperty(
          node.nodeName,
          propName
        );
        if (!DOMProperty.hasSideEffects[name] ||
            ('' + node[propName]) !== defaultValue) {
          node[propName] = defaultValue;
        }
      }
    } else if (DOMProperty.isCustomAttribute(name)) {
      node.removeAttribute(name);
    } else if ("production" !== process.env.NODE_ENV) {
      warnUnknownProperty(name);
    }
  }

};

module.exports = DOMPropertyOperations;

}).call(this,require('_process'))
},{"./DOMProperty":10,"./escapeTextForBrowser":109,"./memoizeStringOnly":135,"./warning":145,"_process":152}],12:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule Danger
 * @typechecks static-only
 */

/*jslint evil: true, sub: true */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var createNodesFromMarkup = require("./createNodesFromMarkup");
var emptyFunction = require("./emptyFunction");
var getMarkupWrap = require("./getMarkupWrap");
var invariant = require("./invariant");

var OPEN_TAG_NAME_EXP = /^(<[^ \/>]+)/;
var RESULT_INDEX_ATTR = 'data-danger-index';

/**
 * Extracts the `nodeName` from a string of markup.
 *
 * NOTE: Extracting the `nodeName` does not require a regular expression match
 * because we make assumptions about React-generated markup (i.e. there are no
 * spaces surrounding the opening tag and there is at least one attribute).
 *
 * @param {string} markup String of markup.
 * @return {string} Node name of the supplied markup.
 * @see http://jsperf.com/extract-nodename
 */
function getNodeName(markup) {
  return markup.substring(1, markup.indexOf(' '));
}

var Danger = {

  /**
   * Renders markup into an array of nodes. The markup is expected to render
   * into a list of root nodes. Also, the length of `resultList` and
   * `markupList` should be the same.
   *
   * @param {array<string>} markupList List of markup strings to render.
   * @return {array<DOMElement>} List of rendered nodes.
   * @internal
   */
  dangerouslyRenderMarkup: function(markupList) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ExecutionEnvironment.canUseDOM,
      'dangerouslyRenderMarkup(...): Cannot render markup in a worker ' +
      'thread. Make sure `window` and `document` are available globally ' +
      'before requiring React when unit testing or use ' +
      'React.renderToString for server rendering.'
    ) : invariant(ExecutionEnvironment.canUseDOM));
    var nodeName;
    var markupByNodeName = {};
    // Group markup by `nodeName` if a wrap is necessary, else by '*'.
    for (var i = 0; i < markupList.length; i++) {
      ("production" !== process.env.NODE_ENV ? invariant(
        markupList[i],
        'dangerouslyRenderMarkup(...): Missing markup.'
      ) : invariant(markupList[i]));
      nodeName = getNodeName(markupList[i]);
      nodeName = getMarkupWrap(nodeName) ? nodeName : '*';
      markupByNodeName[nodeName] = markupByNodeName[nodeName] || [];
      markupByNodeName[nodeName][i] = markupList[i];
    }
    var resultList = [];
    var resultListAssignmentCount = 0;
    for (nodeName in markupByNodeName) {
      if (!markupByNodeName.hasOwnProperty(nodeName)) {
        continue;
      }
      var markupListByNodeName = markupByNodeName[nodeName];

      // This for-in loop skips the holes of the sparse array. The order of
      // iteration should follow the order of assignment, which happens to match
      // numerical index order, but we don't rely on that.
      for (var resultIndex in markupListByNodeName) {
        if (markupListByNodeName.hasOwnProperty(resultIndex)) {
          var markup = markupListByNodeName[resultIndex];

          // Push the requested markup with an additional RESULT_INDEX_ATTR
          // attribute.  If the markup does not start with a < character, it
          // will be discarded below (with an appropriate console.error).
          markupListByNodeName[resultIndex] = markup.replace(
            OPEN_TAG_NAME_EXP,
            // This index will be parsed back out below.
            '$1 ' + RESULT_INDEX_ATTR + '="' + resultIndex + '" '
          );
        }
      }

      // Render each group of markup with similar wrapping `nodeName`.
      var renderNodes = createNodesFromMarkup(
        markupListByNodeName.join(''),
        emptyFunction // Do nothing special with <script> tags.
      );

      for (i = 0; i < renderNodes.length; ++i) {
        var renderNode = renderNodes[i];
        if (renderNode.hasAttribute &&
            renderNode.hasAttribute(RESULT_INDEX_ATTR)) {

          resultIndex = +renderNode.getAttribute(RESULT_INDEX_ATTR);
          renderNode.removeAttribute(RESULT_INDEX_ATTR);

          ("production" !== process.env.NODE_ENV ? invariant(
            !resultList.hasOwnProperty(resultIndex),
            'Danger: Assigning to an already-occupied result index.'
          ) : invariant(!resultList.hasOwnProperty(resultIndex)));

          resultList[resultIndex] = renderNode;

          // This should match resultList.length and markupList.length when
          // we're done.
          resultListAssignmentCount += 1;

        } else if ("production" !== process.env.NODE_ENV) {
          console.error(
            "Danger: Discarding unexpected node:",
            renderNode
          );
        }
      }
    }

    // Although resultList was populated out of order, it should now be a dense
    // array.
    ("production" !== process.env.NODE_ENV ? invariant(
      resultListAssignmentCount === resultList.length,
      'Danger: Did not assign to every index of resultList.'
    ) : invariant(resultListAssignmentCount === resultList.length));

    ("production" !== process.env.NODE_ENV ? invariant(
      resultList.length === markupList.length,
      'Danger: Expected markup to render %s nodes, but rendered %s.',
      markupList.length,
      resultList.length
    ) : invariant(resultList.length === markupList.length));

    return resultList;
  },

  /**
   * Replaces a node with a string of markup at its current position within its
   * parent. The markup must render into a single root node.
   *
   * @param {DOMElement} oldChild Child node to replace.
   * @param {string} markup Markup to render in place of the child node.
   * @internal
   */
  dangerouslyReplaceNodeWithMarkup: function(oldChild, markup) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ExecutionEnvironment.canUseDOM,
      'dangerouslyReplaceNodeWithMarkup(...): Cannot render markup in a ' +
      'worker thread. Make sure `window` and `document` are available ' +
      'globally before requiring React when unit testing or use ' +
      'React.renderToString for server rendering.'
    ) : invariant(ExecutionEnvironment.canUseDOM));
    ("production" !== process.env.NODE_ENV ? invariant(markup, 'dangerouslyReplaceNodeWithMarkup(...): Missing markup.') : invariant(markup));
    ("production" !== process.env.NODE_ENV ? invariant(
      oldChild.tagName.toLowerCase() !== 'html',
      'dangerouslyReplaceNodeWithMarkup(...): Cannot replace markup of the ' +
      '<html> node. This is because browser quirks make this unreliable ' +
      'and/or slow. If you want to render to the root you must use ' +
      'server rendering. See renderComponentToString().'
    ) : invariant(oldChild.tagName.toLowerCase() !== 'html'));

    var newChild = createNodesFromMarkup(markup, emptyFunction)[0];
    oldChild.parentNode.replaceChild(newChild, oldChild);
  }

};

module.exports = Danger;

}).call(this,require('_process'))
},{"./ExecutionEnvironment":21,"./createNodesFromMarkup":104,"./emptyFunction":107,"./getMarkupWrap":118,"./invariant":126,"_process":152}],13:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule DefaultEventPluginOrder
 */

"use strict";

 var keyOf = require("./keyOf");

/**
 * Module that is injectable into `EventPluginHub`, that specifies a
 * deterministic ordering of `EventPlugin`s. A convenient way to reason about
 * plugins, without having to package every one of them. This is better than
 * having plugins be ordered in the same order that they are injected because
 * that ordering would be influenced by the packaging order.
 * `ResponderEventPlugin` must occur before `SimpleEventPlugin` so that
 * preventing default on events is convenient in `SimpleEventPlugin` handlers.
 */
var DefaultEventPluginOrder = [
  keyOf({ResponderEventPlugin: null}),
  keyOf({SimpleEventPlugin: null}),
  keyOf({TapEventPlugin: null}),
  keyOf({EnterLeaveEventPlugin: null}),
  keyOf({ChangeEventPlugin: null}),
  keyOf({SelectEventPlugin: null}),
  keyOf({CompositionEventPlugin: null}),
  keyOf({BeforeInputEventPlugin: null}),
  keyOf({AnalyticsEventPlugin: null}),
  keyOf({MobileSafariClickEventPlugin: null})
];

module.exports = DefaultEventPluginOrder;

},{"./keyOf":133}],14:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EnterLeaveEventPlugin
 * @typechecks static-only
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPropagators = require("./EventPropagators");
var SyntheticMouseEvent = require("./SyntheticMouseEvent");

var ReactMount = require("./ReactMount");
var keyOf = require("./keyOf");

var topLevelTypes = EventConstants.topLevelTypes;
var getFirstReactDOM = ReactMount.getFirstReactDOM;

var eventTypes = {
  mouseEnter: {
    registrationName: keyOf({onMouseEnter: null}),
    dependencies: [
      topLevelTypes.topMouseOut,
      topLevelTypes.topMouseOver
    ]
  },
  mouseLeave: {
    registrationName: keyOf({onMouseLeave: null}),
    dependencies: [
      topLevelTypes.topMouseOut,
      topLevelTypes.topMouseOver
    ]
  }
};

var extractedEvents = [null, null];

var EnterLeaveEventPlugin = {

  eventTypes: eventTypes,

  /**
   * For almost every interaction we care about, there will be both a top-level
   * `mouseover` and `mouseout` event that occurs. Only use `mouseout` so that
   * we do not extract duplicate events. However, moving the mouse into the
   * browser from outside will not fire a `mouseout` event. In this case, we use
   * the `mouseover` top-level event.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {
    if (topLevelType === topLevelTypes.topMouseOver &&
        (nativeEvent.relatedTarget || nativeEvent.fromElement)) {
      return null;
    }
    if (topLevelType !== topLevelTypes.topMouseOut &&
        topLevelType !== topLevelTypes.topMouseOver) {
      // Must not be a mouse in or mouse out - ignoring.
      return null;
    }

    var win;
    if (topLevelTarget.window === topLevelTarget) {
      // `topLevelTarget` is probably a window object.
      win = topLevelTarget;
    } else {
      // TODO: Figure out why `ownerDocument` is sometimes undefined in IE8.
      var doc = topLevelTarget.ownerDocument;
      if (doc) {
        win = doc.defaultView || doc.parentWindow;
      } else {
        win = window;
      }
    }

    var from, to;
    if (topLevelType === topLevelTypes.topMouseOut) {
      from = topLevelTarget;
      to =
        getFirstReactDOM(nativeEvent.relatedTarget || nativeEvent.toElement) ||
        win;
    } else {
      from = win;
      to = topLevelTarget;
    }

    if (from === to) {
      // Nothing pertains to our managed components.
      return null;
    }

    var fromID = from ? ReactMount.getID(from) : '';
    var toID = to ? ReactMount.getID(to) : '';

    var leave = SyntheticMouseEvent.getPooled(
      eventTypes.mouseLeave,
      fromID,
      nativeEvent
    );
    leave.type = 'mouseleave';
    leave.target = from;
    leave.relatedTarget = to;

    var enter = SyntheticMouseEvent.getPooled(
      eventTypes.mouseEnter,
      toID,
      nativeEvent
    );
    enter.type = 'mouseenter';
    enter.target = to;
    enter.relatedTarget = from;

    EventPropagators.accumulateEnterLeaveDispatches(leave, enter, fromID, toID);

    extractedEvents[0] = leave;
    extractedEvents[1] = enter;

    return extractedEvents;
  }

};

module.exports = EnterLeaveEventPlugin;

},{"./EventConstants":15,"./EventPropagators":20,"./ReactMount":63,"./SyntheticMouseEvent":91,"./keyOf":133}],15:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EventConstants
 */

"use strict";

var keyMirror = require("./keyMirror");

var PropagationPhases = keyMirror({bubbled: null, captured: null});

/**
 * Types of raw signals from the browser caught at the top level.
 */
var topLevelTypes = keyMirror({
  topBlur: null,
  topChange: null,
  topClick: null,
  topCompositionEnd: null,
  topCompositionStart: null,
  topCompositionUpdate: null,
  topContextMenu: null,
  topCopy: null,
  topCut: null,
  topDoubleClick: null,
  topDrag: null,
  topDragEnd: null,
  topDragEnter: null,
  topDragExit: null,
  topDragLeave: null,
  topDragOver: null,
  topDragStart: null,
  topDrop: null,
  topError: null,
  topFocus: null,
  topInput: null,
  topKeyDown: null,
  topKeyPress: null,
  topKeyUp: null,
  topLoad: null,
  topMouseDown: null,
  topMouseMove: null,
  topMouseOut: null,
  topMouseOver: null,
  topMouseUp: null,
  topPaste: null,
  topReset: null,
  topScroll: null,
  topSelectionChange: null,
  topSubmit: null,
  topTextInput: null,
  topTouchCancel: null,
  topTouchEnd: null,
  topTouchMove: null,
  topTouchStart: null,
  topWheel: null
});

var EventConstants = {
  topLevelTypes: topLevelTypes,
  PropagationPhases: PropagationPhases
};

module.exports = EventConstants;

},{"./keyMirror":132}],16:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014 Facebook, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @providesModule EventListener
 * @typechecks
 */

var emptyFunction = require("./emptyFunction");

/**
 * Upstream version of event listener. Does not take into account specific
 * nature of platform.
 */
var EventListener = {
  /**
   * Listen to DOM events during the bubble phase.
   *
   * @param {DOMEventTarget} target DOM element to register listener on.
   * @param {string} eventType Event type, e.g. 'click' or 'mouseover'.
   * @param {function} callback Callback function.
   * @return {object} Object with a `remove` method.
   */
  listen: function(target, eventType, callback) {
    if (target.addEventListener) {
      target.addEventListener(eventType, callback, false);
      return {
        remove: function() {
          target.removeEventListener(eventType, callback, false);
        }
      };
    } else if (target.attachEvent) {
      target.attachEvent('on' + eventType, callback);
      return {
        remove: function() {
          target.detachEvent('on' + eventType, callback);
        }
      };
    }
  },

  /**
   * Listen to DOM events during the capture phase.
   *
   * @param {DOMEventTarget} target DOM element to register listener on.
   * @param {string} eventType Event type, e.g. 'click' or 'mouseover'.
   * @param {function} callback Callback function.
   * @return {object} Object with a `remove` method.
   */
  capture: function(target, eventType, callback) {
    if (!target.addEventListener) {
      if ("production" !== process.env.NODE_ENV) {
        console.error(
          'Attempted to listen to events during the capture phase on a ' +
          'browser that does not support the capture phase. Your application ' +
          'will not receive some events.'
        );
      }
      return {
        remove: emptyFunction
      };
    } else {
      target.addEventListener(eventType, callback, true);
      return {
        remove: function() {
          target.removeEventListener(eventType, callback, true);
        }
      };
    }
  },

  registerDefault: function() {}
};

module.exports = EventListener;

}).call(this,require('_process'))
},{"./emptyFunction":107,"_process":152}],17:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EventPluginHub
 */

"use strict";

var EventPluginRegistry = require("./EventPluginRegistry");
var EventPluginUtils = require("./EventPluginUtils");

var accumulateInto = require("./accumulateInto");
var forEachAccumulated = require("./forEachAccumulated");
var invariant = require("./invariant");

/**
 * Internal store for event listeners
 */
var listenerBank = {};

/**
 * Internal queue of events that have accumulated their dispatches and are
 * waiting to have their dispatches executed.
 */
var eventQueue = null;

/**
 * Dispatches an event and releases it back into the pool, unless persistent.
 *
 * @param {?object} event Synthetic event to be dispatched.
 * @private
 */
var executeDispatchesAndRelease = function(event) {
  if (event) {
    var executeDispatch = EventPluginUtils.executeDispatch;
    // Plugins can provide custom behavior when dispatching events.
    var PluginModule = EventPluginRegistry.getPluginModuleForEvent(event);
    if (PluginModule && PluginModule.executeDispatch) {
      executeDispatch = PluginModule.executeDispatch;
    }
    EventPluginUtils.executeDispatchesInOrder(event, executeDispatch);

    if (!event.isPersistent()) {
      event.constructor.release(event);
    }
  }
};

/**
 * - `InstanceHandle`: [required] Module that performs logical traversals of DOM
 *   hierarchy given ids of the logical DOM elements involved.
 */
var InstanceHandle = null;

function validateInstanceHandle() {
  var invalid = !InstanceHandle||
    !InstanceHandle.traverseTwoPhase ||
    !InstanceHandle.traverseEnterLeave;
  if (invalid) {
    throw new Error('InstanceHandle not injected before use!');
  }
}

/**
 * This is a unified interface for event plugins to be installed and configured.
 *
 * Event plugins can implement the following properties:
 *
 *   `extractEvents` {function(string, DOMEventTarget, string, object): *}
 *     Required. When a top-level event is fired, this method is expected to
 *     extract synthetic events that will in turn be queued and dispatched.
 *
 *   `eventTypes` {object}
 *     Optional, plugins that fire events must publish a mapping of registration
 *     names that are used to register listeners. Values of this mapping must
 *     be objects that contain `registrationName` or `phasedRegistrationNames`.
 *
 *   `executeDispatch` {function(object, function, string)}
 *     Optional, allows plugins to override how an event gets dispatched. By
 *     default, the listener is simply invoked.
 *
 * Each plugin that is injected into `EventsPluginHub` is immediately operable.
 *
 * @public
 */
var EventPluginHub = {

  /**
   * Methods for injecting dependencies.
   */
  injection: {

    /**
     * @param {object} InjectedMount
     * @public
     */
    injectMount: EventPluginUtils.injection.injectMount,

    /**
     * @param {object} InjectedInstanceHandle
     * @public
     */
    injectInstanceHandle: function(InjectedInstanceHandle) {
      InstanceHandle = InjectedInstanceHandle;
      if ("production" !== process.env.NODE_ENV) {
        validateInstanceHandle();
      }
    },

    getInstanceHandle: function() {
      if ("production" !== process.env.NODE_ENV) {
        validateInstanceHandle();
      }
      return InstanceHandle;
    },

    /**
     * @param {array} InjectedEventPluginOrder
     * @public
     */
    injectEventPluginOrder: EventPluginRegistry.injectEventPluginOrder,

    /**
     * @param {object} injectedNamesToPlugins Map from names to plugin modules.
     */
    injectEventPluginsByName: EventPluginRegistry.injectEventPluginsByName

  },

  eventNameDispatchConfigs: EventPluginRegistry.eventNameDispatchConfigs,

  registrationNameModules: EventPluginRegistry.registrationNameModules,

  /**
   * Stores `listener` at `listenerBank[registrationName][id]`. Is idempotent.
   *
   * @param {string} id ID of the DOM element.
   * @param {string} registrationName Name of listener (e.g. `onClick`).
   * @param {?function} listener The callback to store.
   */
  putListener: function(id, registrationName, listener) {
    ("production" !== process.env.NODE_ENV ? invariant(
      !listener || typeof listener === 'function',
      'Expected %s listener to be a function, instead got type %s',
      registrationName, typeof listener
    ) : invariant(!listener || typeof listener === 'function'));

    var bankForRegistrationName =
      listenerBank[registrationName] || (listenerBank[registrationName] = {});
    bankForRegistrationName[id] = listener;
  },

  /**
   * @param {string} id ID of the DOM element.
   * @param {string} registrationName Name of listener (e.g. `onClick`).
   * @return {?function} The stored callback.
   */
  getListener: function(id, registrationName) {
    var bankForRegistrationName = listenerBank[registrationName];
    return bankForRegistrationName && bankForRegistrationName[id];
  },

  /**
   * Deletes a listener from the registration bank.
   *
   * @param {string} id ID of the DOM element.
   * @param {string} registrationName Name of listener (e.g. `onClick`).
   */
  deleteListener: function(id, registrationName) {
    var bankForRegistrationName = listenerBank[registrationName];
    if (bankForRegistrationName) {
      delete bankForRegistrationName[id];
    }
  },

  /**
   * Deletes all listeners for the DOM element with the supplied ID.
   *
   * @param {string} id ID of the DOM element.
   */
  deleteAllListeners: function(id) {
    for (var registrationName in listenerBank) {
      delete listenerBank[registrationName][id];
    }
  },

  /**
   * Allows registered plugins an opportunity to extract events from top-level
   * native browser events.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @internal
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {
    var events;
    var plugins = EventPluginRegistry.plugins;
    for (var i = 0, l = plugins.length; i < l; i++) {
      // Not every plugin in the ordering may be loaded at runtime.
      var possiblePlugin = plugins[i];
      if (possiblePlugin) {
        var extractedEvents = possiblePlugin.extractEvents(
          topLevelType,
          topLevelTarget,
          topLevelTargetID,
          nativeEvent
        );
        if (extractedEvents) {
          events = accumulateInto(events, extractedEvents);
        }
      }
    }
    return events;
  },

  /**
   * Enqueues a synthetic event that should be dispatched when
   * `processEventQueue` is invoked.
   *
   * @param {*} events An accumulation of synthetic events.
   * @internal
   */
  enqueueEvents: function(events) {
    if (events) {
      eventQueue = accumulateInto(eventQueue, events);
    }
  },

  /**
   * Dispatches all synthetic events on the event queue.
   *
   * @internal
   */
  processEventQueue: function() {
    // Set `eventQueue` to null before processing it so that we can tell if more
    // events get enqueued while processing.
    var processingEventQueue = eventQueue;
    eventQueue = null;
    forEachAccumulated(processingEventQueue, executeDispatchesAndRelease);
    ("production" !== process.env.NODE_ENV ? invariant(
      !eventQueue,
      'processEventQueue(): Additional events were enqueued while processing ' +
      'an event queue. Support for this has not yet been implemented.'
    ) : invariant(!eventQueue));
  },

  /**
   * These are needed for tests only. Do not use!
   */
  __purge: function() {
    listenerBank = {};
  },

  __getListenerBank: function() {
    return listenerBank;
  }

};

module.exports = EventPluginHub;

}).call(this,require('_process'))
},{"./EventPluginRegistry":18,"./EventPluginUtils":19,"./accumulateInto":97,"./forEachAccumulated":112,"./invariant":126,"_process":152}],18:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EventPluginRegistry
 * @typechecks static-only
 */

"use strict";

var invariant = require("./invariant");

/**
 * Injectable ordering of event plugins.
 */
var EventPluginOrder = null;

/**
 * Injectable mapping from names to event plugin modules.
 */
var namesToPlugins = {};

/**
 * Recomputes the plugin list using the injected plugins and plugin ordering.
 *
 * @private
 */
function recomputePluginOrdering() {
  if (!EventPluginOrder) {
    // Wait until an `EventPluginOrder` is injected.
    return;
  }
  for (var pluginName in namesToPlugins) {
    var PluginModule = namesToPlugins[pluginName];
    var pluginIndex = EventPluginOrder.indexOf(pluginName);
    ("production" !== process.env.NODE_ENV ? invariant(
      pluginIndex > -1,
      'EventPluginRegistry: Cannot inject event plugins that do not exist in ' +
      'the plugin ordering, `%s`.',
      pluginName
    ) : invariant(pluginIndex > -1));
    if (EventPluginRegistry.plugins[pluginIndex]) {
      continue;
    }
    ("production" !== process.env.NODE_ENV ? invariant(
      PluginModule.extractEvents,
      'EventPluginRegistry: Event plugins must implement an `extractEvents` ' +
      'method, but `%s` does not.',
      pluginName
    ) : invariant(PluginModule.extractEvents));
    EventPluginRegistry.plugins[pluginIndex] = PluginModule;
    var publishedEvents = PluginModule.eventTypes;
    for (var eventName in publishedEvents) {
      ("production" !== process.env.NODE_ENV ? invariant(
        publishEventForPlugin(
          publishedEvents[eventName],
          PluginModule,
          eventName
        ),
        'EventPluginRegistry: Failed to publish event `%s` for plugin `%s`.',
        eventName,
        pluginName
      ) : invariant(publishEventForPlugin(
        publishedEvents[eventName],
        PluginModule,
        eventName
      )));
    }
  }
}

/**
 * Publishes an event so that it can be dispatched by the supplied plugin.
 *
 * @param {object} dispatchConfig Dispatch configuration for the event.
 * @param {object} PluginModule Plugin publishing the event.
 * @return {boolean} True if the event was successfully published.
 * @private
 */
function publishEventForPlugin(dispatchConfig, PluginModule, eventName) {
  ("production" !== process.env.NODE_ENV ? invariant(
    !EventPluginRegistry.eventNameDispatchConfigs.hasOwnProperty(eventName),
    'EventPluginHub: More than one plugin attempted to publish the same ' +
    'event name, `%s`.',
    eventName
  ) : invariant(!EventPluginRegistry.eventNameDispatchConfigs.hasOwnProperty(eventName)));
  EventPluginRegistry.eventNameDispatchConfigs[eventName] = dispatchConfig;

  var phasedRegistrationNames = dispatchConfig.phasedRegistrationNames;
  if (phasedRegistrationNames) {
    for (var phaseName in phasedRegistrationNames) {
      if (phasedRegistrationNames.hasOwnProperty(phaseName)) {
        var phasedRegistrationName = phasedRegistrationNames[phaseName];
        publishRegistrationName(
          phasedRegistrationName,
          PluginModule,
          eventName
        );
      }
    }
    return true;
  } else if (dispatchConfig.registrationName) {
    publishRegistrationName(
      dispatchConfig.registrationName,
      PluginModule,
      eventName
    );
    return true;
  }
  return false;
}

/**
 * Publishes a registration name that is used to identify dispatched events and
 * can be used with `EventPluginHub.putListener` to register listeners.
 *
 * @param {string} registrationName Registration name to add.
 * @param {object} PluginModule Plugin publishing the event.
 * @private
 */
function publishRegistrationName(registrationName, PluginModule, eventName) {
  ("production" !== process.env.NODE_ENV ? invariant(
    !EventPluginRegistry.registrationNameModules[registrationName],
    'EventPluginHub: More than one plugin attempted to publish the same ' +
    'registration name, `%s`.',
    registrationName
  ) : invariant(!EventPluginRegistry.registrationNameModules[registrationName]));
  EventPluginRegistry.registrationNameModules[registrationName] = PluginModule;
  EventPluginRegistry.registrationNameDependencies[registrationName] =
    PluginModule.eventTypes[eventName].dependencies;
}

/**
 * Registers plugins so that they can extract and dispatch events.
 *
 * @see {EventPluginHub}
 */
var EventPluginRegistry = {

  /**
   * Ordered list of injected plugins.
   */
  plugins: [],

  /**
   * Mapping from event name to dispatch config
   */
  eventNameDispatchConfigs: {},

  /**
   * Mapping from registration name to plugin module
   */
  registrationNameModules: {},

  /**
   * Mapping from registration name to event name
   */
  registrationNameDependencies: {},

  /**
   * Injects an ordering of plugins (by plugin name). This allows the ordering
   * to be decoupled from injection of the actual plugins so that ordering is
   * always deterministic regardless of packaging, on-the-fly injection, etc.
   *
   * @param {array} InjectedEventPluginOrder
   * @internal
   * @see {EventPluginHub.injection.injectEventPluginOrder}
   */
  injectEventPluginOrder: function(InjectedEventPluginOrder) {
    ("production" !== process.env.NODE_ENV ? invariant(
      !EventPluginOrder,
      'EventPluginRegistry: Cannot inject event plugin ordering more than ' +
      'once. You are likely trying to load more than one copy of React.'
    ) : invariant(!EventPluginOrder));
    // Clone the ordering so it cannot be dynamically mutated.
    EventPluginOrder = Array.prototype.slice.call(InjectedEventPluginOrder);
    recomputePluginOrdering();
  },

  /**
   * Injects plugins to be used by `EventPluginHub`. The plugin names must be
   * in the ordering injected by `injectEventPluginOrder`.
   *
   * Plugins can be injected as part of page initialization or on-the-fly.
   *
   * @param {object} injectedNamesToPlugins Map from names to plugin modules.
   * @internal
   * @see {EventPluginHub.injection.injectEventPluginsByName}
   */
  injectEventPluginsByName: function(injectedNamesToPlugins) {
    var isOrderingDirty = false;
    for (var pluginName in injectedNamesToPlugins) {
      if (!injectedNamesToPlugins.hasOwnProperty(pluginName)) {
        continue;
      }
      var PluginModule = injectedNamesToPlugins[pluginName];
      if (!namesToPlugins.hasOwnProperty(pluginName) ||
          namesToPlugins[pluginName] !== PluginModule) {
        ("production" !== process.env.NODE_ENV ? invariant(
          !namesToPlugins[pluginName],
          'EventPluginRegistry: Cannot inject two different event plugins ' +
          'using the same name, `%s`.',
          pluginName
        ) : invariant(!namesToPlugins[pluginName]));
        namesToPlugins[pluginName] = PluginModule;
        isOrderingDirty = true;
      }
    }
    if (isOrderingDirty) {
      recomputePluginOrdering();
    }
  },

  /**
   * Looks up the plugin for the supplied event.
   *
   * @param {object} event A synthetic event.
   * @return {?object} The plugin that created the supplied event.
   * @internal
   */
  getPluginModuleForEvent: function(event) {
    var dispatchConfig = event.dispatchConfig;
    if (dispatchConfig.registrationName) {
      return EventPluginRegistry.registrationNameModules[
        dispatchConfig.registrationName
      ] || null;
    }
    for (var phase in dispatchConfig.phasedRegistrationNames) {
      if (!dispatchConfig.phasedRegistrationNames.hasOwnProperty(phase)) {
        continue;
      }
      var PluginModule = EventPluginRegistry.registrationNameModules[
        dispatchConfig.phasedRegistrationNames[phase]
      ];
      if (PluginModule) {
        return PluginModule;
      }
    }
    return null;
  },

  /**
   * Exposed for unit testing.
   * @private
   */
  _resetEventPlugins: function() {
    EventPluginOrder = null;
    for (var pluginName in namesToPlugins) {
      if (namesToPlugins.hasOwnProperty(pluginName)) {
        delete namesToPlugins[pluginName];
      }
    }
    EventPluginRegistry.plugins.length = 0;

    var eventNameDispatchConfigs = EventPluginRegistry.eventNameDispatchConfigs;
    for (var eventName in eventNameDispatchConfigs) {
      if (eventNameDispatchConfigs.hasOwnProperty(eventName)) {
        delete eventNameDispatchConfigs[eventName];
      }
    }

    var registrationNameModules = EventPluginRegistry.registrationNameModules;
    for (var registrationName in registrationNameModules) {
      if (registrationNameModules.hasOwnProperty(registrationName)) {
        delete registrationNameModules[registrationName];
      }
    }
  }

};

module.exports = EventPluginRegistry;

}).call(this,require('_process'))
},{"./invariant":126,"_process":152}],19:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EventPluginUtils
 */

"use strict";

var EventConstants = require("./EventConstants");

var invariant = require("./invariant");

/**
 * Injected dependencies:
 */

/**
 * - `Mount`: [required] Module that can convert between React dom IDs and
 *   actual node references.
 */
var injection = {
  Mount: null,
  injectMount: function(InjectedMount) {
    injection.Mount = InjectedMount;
    if ("production" !== process.env.NODE_ENV) {
      ("production" !== process.env.NODE_ENV ? invariant(
        InjectedMount && InjectedMount.getNode,
        'EventPluginUtils.injection.injectMount(...): Injected Mount module ' +
        'is missing getNode.'
      ) : invariant(InjectedMount && InjectedMount.getNode));
    }
  }
};

var topLevelTypes = EventConstants.topLevelTypes;

function isEndish(topLevelType) {
  return topLevelType === topLevelTypes.topMouseUp ||
         topLevelType === topLevelTypes.topTouchEnd ||
         topLevelType === topLevelTypes.topTouchCancel;
}

function isMoveish(topLevelType) {
  return topLevelType === topLevelTypes.topMouseMove ||
         topLevelType === topLevelTypes.topTouchMove;
}
function isStartish(topLevelType) {
  return topLevelType === topLevelTypes.topMouseDown ||
         topLevelType === topLevelTypes.topTouchStart;
}


var validateEventDispatches;
if ("production" !== process.env.NODE_ENV) {
  validateEventDispatches = function(event) {
    var dispatchListeners = event._dispatchListeners;
    var dispatchIDs = event._dispatchIDs;

    var listenersIsArr = Array.isArray(dispatchListeners);
    var idsIsArr = Array.isArray(dispatchIDs);
    var IDsLen = idsIsArr ? dispatchIDs.length : dispatchIDs ? 1 : 0;
    var listenersLen = listenersIsArr ?
      dispatchListeners.length :
      dispatchListeners ? 1 : 0;

    ("production" !== process.env.NODE_ENV ? invariant(
      idsIsArr === listenersIsArr && IDsLen === listenersLen,
      'EventPluginUtils: Invalid `event`.'
    ) : invariant(idsIsArr === listenersIsArr && IDsLen === listenersLen));
  };
}

/**
 * Invokes `cb(event, listener, id)`. Avoids using call if no scope is
 * provided. The `(listener,id)` pair effectively forms the "dispatch" but are
 * kept separate to conserve memory.
 */
function forEachEventDispatch(event, cb) {
  var dispatchListeners = event._dispatchListeners;
  var dispatchIDs = event._dispatchIDs;
  if ("production" !== process.env.NODE_ENV) {
    validateEventDispatches(event);
  }
  if (Array.isArray(dispatchListeners)) {
    for (var i = 0; i < dispatchListeners.length; i++) {
      if (event.isPropagationStopped()) {
        break;
      }
      // Listeners and IDs are two parallel arrays that are always in sync.
      cb(event, dispatchListeners[i], dispatchIDs[i]);
    }
  } else if (dispatchListeners) {
    cb(event, dispatchListeners, dispatchIDs);
  }
}

/**
 * Default implementation of PluginModule.executeDispatch().
 * @param {SyntheticEvent} SyntheticEvent to handle
 * @param {function} Application-level callback
 * @param {string} domID DOM id to pass to the callback.
 */
function executeDispatch(event, listener, domID) {
  event.currentTarget = injection.Mount.getNode(domID);
  var returnValue = listener(event, domID);
  event.currentTarget = null;
  return returnValue;
}

/**
 * Standard/simple iteration through an event's collected dispatches.
 */
function executeDispatchesInOrder(event, executeDispatch) {
  forEachEventDispatch(event, executeDispatch);
  event._dispatchListeners = null;
  event._dispatchIDs = null;
}

/**
 * Standard/simple iteration through an event's collected dispatches, but stops
 * at the first dispatch execution returning true, and returns that id.
 *
 * @return id of the first dispatch execution who's listener returns true, or
 * null if no listener returned true.
 */
function executeDispatchesInOrderStopAtTrueImpl(event) {
  var dispatchListeners = event._dispatchListeners;
  var dispatchIDs = event._dispatchIDs;
  if ("production" !== process.env.NODE_ENV) {
    validateEventDispatches(event);
  }
  if (Array.isArray(dispatchListeners)) {
    for (var i = 0; i < dispatchListeners.length; i++) {
      if (event.isPropagationStopped()) {
        break;
      }
      // Listeners and IDs are two parallel arrays that are always in sync.
      if (dispatchListeners[i](event, dispatchIDs[i])) {
        return dispatchIDs[i];
      }
    }
  } else if (dispatchListeners) {
    if (dispatchListeners(event, dispatchIDs)) {
      return dispatchIDs;
    }
  }
  return null;
}

/**
 * @see executeDispatchesInOrderStopAtTrueImpl
 */
function executeDispatchesInOrderStopAtTrue(event) {
  var ret = executeDispatchesInOrderStopAtTrueImpl(event);
  event._dispatchIDs = null;
  event._dispatchListeners = null;
  return ret;
}

/**
 * Execution of a "direct" dispatch - there must be at most one dispatch
 * accumulated on the event or it is considered an error. It doesn't really make
 * sense for an event with multiple dispatches (bubbled) to keep track of the
 * return values at each dispatch execution, but it does tend to make sense when
 * dealing with "direct" dispatches.
 *
 * @return The return value of executing the single dispatch.
 */
function executeDirectDispatch(event) {
  if ("production" !== process.env.NODE_ENV) {
    validateEventDispatches(event);
  }
  var dispatchListener = event._dispatchListeners;
  var dispatchID = event._dispatchIDs;
  ("production" !== process.env.NODE_ENV ? invariant(
    !Array.isArray(dispatchListener),
    'executeDirectDispatch(...): Invalid `event`.'
  ) : invariant(!Array.isArray(dispatchListener)));
  var res = dispatchListener ?
    dispatchListener(event, dispatchID) :
    null;
  event._dispatchListeners = null;
  event._dispatchIDs = null;
  return res;
}

/**
 * @param {SyntheticEvent} event
 * @return {bool} True iff number of dispatches accumulated is greater than 0.
 */
function hasDispatches(event) {
  return !!event._dispatchListeners;
}

/**
 * General utilities that are useful in creating custom Event Plugins.
 */
var EventPluginUtils = {
  isEndish: isEndish,
  isMoveish: isMoveish,
  isStartish: isStartish,

  executeDirectDispatch: executeDirectDispatch,
  executeDispatch: executeDispatch,
  executeDispatchesInOrder: executeDispatchesInOrder,
  executeDispatchesInOrderStopAtTrue: executeDispatchesInOrderStopAtTrue,
  hasDispatches: hasDispatches,
  injection: injection,
  useTouchEvents: false
};

module.exports = EventPluginUtils;

}).call(this,require('_process'))
},{"./EventConstants":15,"./invariant":126,"_process":152}],20:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EventPropagators
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPluginHub = require("./EventPluginHub");

var accumulateInto = require("./accumulateInto");
var forEachAccumulated = require("./forEachAccumulated");

var PropagationPhases = EventConstants.PropagationPhases;
var getListener = EventPluginHub.getListener;

/**
 * Some event types have a notion of different registration names for different
 * "phases" of propagation. This finds listeners by a given phase.
 */
function listenerAtPhase(id, event, propagationPhase) {
  var registrationName =
    event.dispatchConfig.phasedRegistrationNames[propagationPhase];
  return getListener(id, registrationName);
}

/**
 * Tags a `SyntheticEvent` with dispatched listeners. Creating this function
 * here, allows us to not have to bind or create functions for each event.
 * Mutating the event's members allows us to not have to create a wrapping
 * "dispatch" object that pairs the event with the listener.
 */
function accumulateDirectionalDispatches(domID, upwards, event) {
  if ("production" !== process.env.NODE_ENV) {
    if (!domID) {
      throw new Error('Dispatching id must not be null');
    }
  }
  var phase = upwards ? PropagationPhases.bubbled : PropagationPhases.captured;
  var listener = listenerAtPhase(domID, event, phase);
  if (listener) {
    event._dispatchListeners =
      accumulateInto(event._dispatchListeners, listener);
    event._dispatchIDs = accumulateInto(event._dispatchIDs, domID);
  }
}

/**
 * Collect dispatches (must be entirely collected before dispatching - see unit
 * tests). Lazily allocate the array to conserve memory.  We must loop through
 * each event and perform the traversal for each one. We can not perform a
 * single traversal for the entire collection of events because each event may
 * have a different target.
 */
function accumulateTwoPhaseDispatchesSingle(event) {
  if (event && event.dispatchConfig.phasedRegistrationNames) {
    EventPluginHub.injection.getInstanceHandle().traverseTwoPhase(
      event.dispatchMarker,
      accumulateDirectionalDispatches,
      event
    );
  }
}


/**
 * Accumulates without regard to direction, does not look for phased
 * registration names. Same as `accumulateDirectDispatchesSingle` but without
 * requiring that the `dispatchMarker` be the same as the dispatched ID.
 */
function accumulateDispatches(id, ignoredDirection, event) {
  if (event && event.dispatchConfig.registrationName) {
    var registrationName = event.dispatchConfig.registrationName;
    var listener = getListener(id, registrationName);
    if (listener) {
      event._dispatchListeners =
        accumulateInto(event._dispatchListeners, listener);
      event._dispatchIDs = accumulateInto(event._dispatchIDs, id);
    }
  }
}

/**
 * Accumulates dispatches on an `SyntheticEvent`, but only for the
 * `dispatchMarker`.
 * @param {SyntheticEvent} event
 */
function accumulateDirectDispatchesSingle(event) {
  if (event && event.dispatchConfig.registrationName) {
    accumulateDispatches(event.dispatchMarker, null, event);
  }
}

function accumulateTwoPhaseDispatches(events) {
  forEachAccumulated(events, accumulateTwoPhaseDispatchesSingle);
}

function accumulateEnterLeaveDispatches(leave, enter, fromID, toID) {
  EventPluginHub.injection.getInstanceHandle().traverseEnterLeave(
    fromID,
    toID,
    accumulateDispatches,
    leave,
    enter
  );
}


function accumulateDirectDispatches(events) {
  forEachAccumulated(events, accumulateDirectDispatchesSingle);
}



/**
 * A small set of propagation patterns, each of which will accept a small amount
 * of information, and generate a set of "dispatch ready event objects" - which
 * are sets of events that have already been annotated with a set of dispatched
 * listener functions/ids. The API is designed this way to discourage these
 * propagation strategies from actually executing the dispatches, since we
 * always want to collect the entire set of dispatches before executing event a
 * single one.
 *
 * @constructor EventPropagators
 */
var EventPropagators = {
  accumulateTwoPhaseDispatches: accumulateTwoPhaseDispatches,
  accumulateDirectDispatches: accumulateDirectDispatches,
  accumulateEnterLeaveDispatches: accumulateEnterLeaveDispatches
};

module.exports = EventPropagators;

}).call(this,require('_process'))
},{"./EventConstants":15,"./EventPluginHub":17,"./accumulateInto":97,"./forEachAccumulated":112,"_process":152}],21:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ExecutionEnvironment
 */

/*jslint evil: true */

"use strict";

var canUseDOM = !!(
  typeof window !== 'undefined' &&
  window.document &&
  window.document.createElement
);

/**
 * Simple, lightweight module assisting with the detection and context of
 * Worker. Helps avoid circular dependencies and allows code to reason about
 * whether or not they are in a Worker, even if they never include the main
 * `ReactWorker` dependency.
 */
var ExecutionEnvironment = {

  canUseDOM: canUseDOM,

  canUseWorkers: typeof Worker !== 'undefined',

  canUseEventListeners:
    canUseDOM && !!(window.addEventListener || window.attachEvent),

  canUseViewport: canUseDOM && !!window.screen,

  isInWorker: !canUseDOM // For now, this is true - might change in the future.

};

module.exports = ExecutionEnvironment;

},{}],22:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule HTMLDOMPropertyConfig
 */

/*jslint bitwise: true*/

"use strict";

var DOMProperty = require("./DOMProperty");
var ExecutionEnvironment = require("./ExecutionEnvironment");

var MUST_USE_ATTRIBUTE = DOMProperty.injection.MUST_USE_ATTRIBUTE;
var MUST_USE_PROPERTY = DOMProperty.injection.MUST_USE_PROPERTY;
var HAS_BOOLEAN_VALUE = DOMProperty.injection.HAS_BOOLEAN_VALUE;
var HAS_SIDE_EFFECTS = DOMProperty.injection.HAS_SIDE_EFFECTS;
var HAS_NUMERIC_VALUE = DOMProperty.injection.HAS_NUMERIC_VALUE;
var HAS_POSITIVE_NUMERIC_VALUE =
  DOMProperty.injection.HAS_POSITIVE_NUMERIC_VALUE;
var HAS_OVERLOADED_BOOLEAN_VALUE =
  DOMProperty.injection.HAS_OVERLOADED_BOOLEAN_VALUE;

var hasSVG;
if (ExecutionEnvironment.canUseDOM) {
  var implementation = document.implementation;
  hasSVG = (
    implementation &&
    implementation.hasFeature &&
    implementation.hasFeature(
      'http://www.w3.org/TR/SVG11/feature#BasicStructure',
      '1.1'
    )
  );
}


var HTMLDOMPropertyConfig = {
  isCustomAttribute: RegExp.prototype.test.bind(
    /^(data|aria)-[a-z_][a-z\d_.\-]*$/
  ),
  Properties: {
    /**
     * Standard Properties
     */
    accept: null,
    acceptCharset: null,
    accessKey: null,
    action: null,
    allowFullScreen: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
    allowTransparency: MUST_USE_ATTRIBUTE,
    alt: null,
    async: HAS_BOOLEAN_VALUE,
    autoComplete: null,
    // autoFocus is polyfilled/normalized by AutoFocusMixin
    // autoFocus: HAS_BOOLEAN_VALUE,
    autoPlay: HAS_BOOLEAN_VALUE,
    cellPadding: null,
    cellSpacing: null,
    charSet: MUST_USE_ATTRIBUTE,
    checked: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    classID: MUST_USE_ATTRIBUTE,
    // To set className on SVG elements, it's necessary to use .setAttribute;
    // this works on HTML elements too in all browsers except IE8. Conveniently,
    // IE8 doesn't support SVG and so we can simply use the attribute in
    // browsers that support SVG and the property in browsers that don't,
    // regardless of whether the element is HTML or SVG.
    className: hasSVG ? MUST_USE_ATTRIBUTE : MUST_USE_PROPERTY,
    cols: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
    colSpan: null,
    content: null,
    contentEditable: null,
    contextMenu: MUST_USE_ATTRIBUTE,
    controls: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    coords: null,
    crossOrigin: null,
    data: null, // For `<object />` acts as `src`.
    dateTime: MUST_USE_ATTRIBUTE,
    defer: HAS_BOOLEAN_VALUE,
    dir: null,
    disabled: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
    download: HAS_OVERLOADED_BOOLEAN_VALUE,
    draggable: null,
    encType: null,
    form: MUST_USE_ATTRIBUTE,
    formNoValidate: HAS_BOOLEAN_VALUE,
    frameBorder: MUST_USE_ATTRIBUTE,
    height: MUST_USE_ATTRIBUTE,
    hidden: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
    href: null,
    hrefLang: null,
    htmlFor: null,
    httpEquiv: null,
    icon: null,
    id: MUST_USE_PROPERTY,
    label: null,
    lang: null,
    list: MUST_USE_ATTRIBUTE,
    loop: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    manifest: MUST_USE_ATTRIBUTE,
    max: null,
    maxLength: MUST_USE_ATTRIBUTE,
    media: MUST_USE_ATTRIBUTE,
    mediaGroup: null,
    method: null,
    min: null,
    multiple: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    muted: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    name: null,
    noValidate: HAS_BOOLEAN_VALUE,
    open: null,
    pattern: null,
    placeholder: null,
    poster: null,
    preload: null,
    radioGroup: null,
    readOnly: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    rel: null,
    required: HAS_BOOLEAN_VALUE,
    role: MUST_USE_ATTRIBUTE,
    rows: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
    rowSpan: null,
    sandbox: null,
    scope: null,
    scrolling: null,
    seamless: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
    selected: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    shape: null,
    size: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
    sizes: MUST_USE_ATTRIBUTE,
    span: HAS_POSITIVE_NUMERIC_VALUE,
    spellCheck: null,
    src: null,
    srcDoc: MUST_USE_PROPERTY,
    srcSet: MUST_USE_ATTRIBUTE,
    start: HAS_NUMERIC_VALUE,
    step: null,
    style: null,
    tabIndex: null,
    target: null,
    title: null,
    type: null,
    useMap: null,
    value: MUST_USE_PROPERTY | HAS_SIDE_EFFECTS,
    width: MUST_USE_ATTRIBUTE,
    wmode: MUST_USE_ATTRIBUTE,

    /**
     * Non-standard Properties
     */
    autoCapitalize: null, // Supported in Mobile Safari for keyboard hints
    autoCorrect: null, // Supported in Mobile Safari for keyboard hints
    itemProp: MUST_USE_ATTRIBUTE, // Microdata: http://schema.org/docs/gs.html
    itemScope: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE, // Microdata: http://schema.org/docs/gs.html
    itemType: MUST_USE_ATTRIBUTE, // Microdata: http://schema.org/docs/gs.html
    property: null // Supports OG in meta tags
  },
  DOMAttributeNames: {
    acceptCharset: 'accept-charset',
    className: 'class',
    htmlFor: 'for',
    httpEquiv: 'http-equiv'
  },
  DOMPropertyNames: {
    autoCapitalize: 'autocapitalize',
    autoComplete: 'autocomplete',
    autoCorrect: 'autocorrect',
    autoFocus: 'autofocus',
    autoPlay: 'autoplay',
    encType: 'enctype',
    hrefLang: 'hreflang',
    radioGroup: 'radiogroup',
    spellCheck: 'spellcheck',
    srcDoc: 'srcdoc',
    srcSet: 'srcset'
  }
};

module.exports = HTMLDOMPropertyConfig;

},{"./DOMProperty":10,"./ExecutionEnvironment":21}],23:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule LinkedValueUtils
 * @typechecks static-only
 */

"use strict";

var ReactPropTypes = require("./ReactPropTypes");

var invariant = require("./invariant");

var hasReadOnlyValue = {
  'button': true,
  'checkbox': true,
  'image': true,
  'hidden': true,
  'radio': true,
  'reset': true,
  'submit': true
};

function _assertSingleLink(input) {
  ("production" !== process.env.NODE_ENV ? invariant(
    input.props.checkedLink == null || input.props.valueLink == null,
    'Cannot provide a checkedLink and a valueLink. If you want to use ' +
    'checkedLink, you probably don\'t want to use valueLink and vice versa.'
  ) : invariant(input.props.checkedLink == null || input.props.valueLink == null));
}
function _assertValueLink(input) {
  _assertSingleLink(input);
  ("production" !== process.env.NODE_ENV ? invariant(
    input.props.value == null && input.props.onChange == null,
    'Cannot provide a valueLink and a value or onChange event. If you want ' +
    'to use value or onChange, you probably don\'t want to use valueLink.'
  ) : invariant(input.props.value == null && input.props.onChange == null));
}

function _assertCheckedLink(input) {
  _assertSingleLink(input);
  ("production" !== process.env.NODE_ENV ? invariant(
    input.props.checked == null && input.props.onChange == null,
    'Cannot provide a checkedLink and a checked property or onChange event. ' +
    'If you want to use checked or onChange, you probably don\'t want to ' +
    'use checkedLink'
  ) : invariant(input.props.checked == null && input.props.onChange == null));
}

/**
 * @param {SyntheticEvent} e change event to handle
 */
function _handleLinkedValueChange(e) {
  /*jshint validthis:true */
  this.props.valueLink.requestChange(e.target.value);
}

/**
  * @param {SyntheticEvent} e change event to handle
  */
function _handleLinkedCheckChange(e) {
  /*jshint validthis:true */
  this.props.checkedLink.requestChange(e.target.checked);
}

/**
 * Provide a linked `value` attribute for controlled forms. You should not use
 * this outside of the ReactDOM controlled form components.
 */
var LinkedValueUtils = {
  Mixin: {
    propTypes: {
      value: function(props, propName, componentName) {
        if (!props[propName] ||
            hasReadOnlyValue[props.type] ||
            props.onChange ||
            props.readOnly ||
            props.disabled) {
          return;
        }
        return new Error(
          'You provided a `value` prop to a form field without an ' +
          '`onChange` handler. This will render a read-only field. If ' +
          'the field should be mutable use `defaultValue`. Otherwise, ' +
          'set either `onChange` or `readOnly`.'
        );
      },
      checked: function(props, propName, componentName) {
        if (!props[propName] ||
            props.onChange ||
            props.readOnly ||
            props.disabled) {
          return;
        }
        return new Error(
          'You provided a `checked` prop to a form field without an ' +
          '`onChange` handler. This will render a read-only field. If ' +
          'the field should be mutable use `defaultChecked`. Otherwise, ' +
          'set either `onChange` or `readOnly`.'
        );
      },
      onChange: ReactPropTypes.func
    }
  },

  /**
   * @param {ReactComponent} input Form component
   * @return {*} current value of the input either from value prop or link.
   */
  getValue: function(input) {
    if (input.props.valueLink) {
      _assertValueLink(input);
      return input.props.valueLink.value;
    }
    return input.props.value;
  },

  /**
   * @param {ReactComponent} input Form component
   * @return {*} current checked status of the input either from checked prop
   *             or link.
   */
  getChecked: function(input) {
    if (input.props.checkedLink) {
      _assertCheckedLink(input);
      return input.props.checkedLink.value;
    }
    return input.props.checked;
  },

  /**
   * @param {ReactComponent} input Form component
   * @return {function} change callback either from onChange prop or link.
   */
  getOnChange: function(input) {
    if (input.props.valueLink) {
      _assertValueLink(input);
      return _handleLinkedValueChange;
    } else if (input.props.checkedLink) {
      _assertCheckedLink(input);
      return _handleLinkedCheckChange;
    }
    return input.props.onChange;
  }
};

module.exports = LinkedValueUtils;

}).call(this,require('_process'))
},{"./ReactPropTypes":72,"./invariant":126,"_process":152}],24:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule LocalEventTrapMixin
 */

"use strict";

var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");

var accumulateInto = require("./accumulateInto");
var forEachAccumulated = require("./forEachAccumulated");
var invariant = require("./invariant");

function remove(event) {
  event.remove();
}

var LocalEventTrapMixin = {
  trapBubbledEvent:function(topLevelType, handlerBaseName) {
    ("production" !== process.env.NODE_ENV ? invariant(this.isMounted(), 'Must be mounted to trap events') : invariant(this.isMounted()));
    var listener = ReactBrowserEventEmitter.trapBubbledEvent(
      topLevelType,
      handlerBaseName,
      this.getDOMNode()
    );
    this._localEventListeners =
      accumulateInto(this._localEventListeners, listener);
  },

  // trapCapturedEvent would look nearly identical. We don't implement that
  // method because it isn't currently needed.

  componentWillUnmount:function() {
    if (this._localEventListeners) {
      forEachAccumulated(this._localEventListeners, remove);
    }
  }
};

module.exports = LocalEventTrapMixin;

}).call(this,require('_process'))
},{"./ReactBrowserEventEmitter":30,"./accumulateInto":97,"./forEachAccumulated":112,"./invariant":126,"_process":152}],25:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule MobileSafariClickEventPlugin
 * @typechecks static-only
 */

"use strict";

var EventConstants = require("./EventConstants");

var emptyFunction = require("./emptyFunction");

var topLevelTypes = EventConstants.topLevelTypes;

/**
 * Mobile Safari does not fire properly bubble click events on non-interactive
 * elements, which means delegated click listeners do not fire. The workaround
 * for this bug involves attaching an empty click listener on the target node.
 *
 * This particular plugin works around the bug by attaching an empty click
 * listener on `touchstart` (which does fire on every element).
 */
var MobileSafariClickEventPlugin = {

  eventTypes: null,

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {
    if (topLevelType === topLevelTypes.topTouchStart) {
      var target = nativeEvent.target;
      if (target && !target.onclick) {
        target.onclick = emptyFunction;
      }
    }
  }

};

module.exports = MobileSafariClickEventPlugin;

},{"./EventConstants":15,"./emptyFunction":107}],26:[function(require,module,exports){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule Object.assign
 */

// https://people.mozilla.org/~jorendorff/es6-draft.html#sec-object.assign

function assign(target, sources) {
  if (target == null) {
    throw new TypeError('Object.assign target cannot be null or undefined');
  }

  var to = Object(target);
  var hasOwnProperty = Object.prototype.hasOwnProperty;

  for (var nextIndex = 1; nextIndex < arguments.length; nextIndex++) {
    var nextSource = arguments[nextIndex];
    if (nextSource == null) {
      continue;
    }

    var from = Object(nextSource);

    // We don't currently support accessors nor proxies. Therefore this
    // copy cannot throw. If we ever supported this then we must handle
    // exceptions and side-effects. We don't support symbols so they won't
    // be transferred.

    for (var key in from) {
      if (hasOwnProperty.call(from, key)) {
        to[key] = from[key];
      }
    }
  }

  return to;
};

module.exports = assign;

},{}],27:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule PooledClass
 */

"use strict";

var invariant = require("./invariant");

/**
 * Static poolers. Several custom versions for each potential number of
 * arguments. A completely generic pooler is easy to implement, but would
 * require accessing the `arguments` object. In each of these, `this` refers to
 * the Class itself, not an instance. If any others are needed, simply add them
 * here, or in their own files.
 */
var oneArgumentPooler = function(copyFieldsFrom) {
  var Klass = this;
  if (Klass.instancePool.length) {
    var instance = Klass.instancePool.pop();
    Klass.call(instance, copyFieldsFrom);
    return instance;
  } else {
    return new Klass(copyFieldsFrom);
  }
};

var twoArgumentPooler = function(a1, a2) {
  var Klass = this;
  if (Klass.instancePool.length) {
    var instance = Klass.instancePool.pop();
    Klass.call(instance, a1, a2);
    return instance;
  } else {
    return new Klass(a1, a2);
  }
};

var threeArgumentPooler = function(a1, a2, a3) {
  var Klass = this;
  if (Klass.instancePool.length) {
    var instance = Klass.instancePool.pop();
    Klass.call(instance, a1, a2, a3);
    return instance;
  } else {
    return new Klass(a1, a2, a3);
  }
};

var fiveArgumentPooler = function(a1, a2, a3, a4, a5) {
  var Klass = this;
  if (Klass.instancePool.length) {
    var instance = Klass.instancePool.pop();
    Klass.call(instance, a1, a2, a3, a4, a5);
    return instance;
  } else {
    return new Klass(a1, a2, a3, a4, a5);
  }
};

var standardReleaser = function(instance) {
  var Klass = this;
  ("production" !== process.env.NODE_ENV ? invariant(
    instance instanceof Klass,
    'Trying to release an instance into a pool of a different type.'
  ) : invariant(instance instanceof Klass));
  if (instance.destructor) {
    instance.destructor();
  }
  if (Klass.instancePool.length < Klass.poolSize) {
    Klass.instancePool.push(instance);
  }
};

var DEFAULT_POOL_SIZE = 10;
var DEFAULT_POOLER = oneArgumentPooler;

/**
 * Augments `CopyConstructor` to be a poolable class, augmenting only the class
 * itself (statically) not adding any prototypical fields. Any CopyConstructor
 * you give this may have a `poolSize` property, and will look for a
 * prototypical `destructor` on instances (optional).
 *
 * @param {Function} CopyConstructor Constructor that can be used to reset.
 * @param {Function} pooler Customizable pooler.
 */
var addPoolingTo = function(CopyConstructor, pooler) {
  var NewKlass = CopyConstructor;
  NewKlass.instancePool = [];
  NewKlass.getPooled = pooler || DEFAULT_POOLER;
  if (!NewKlass.poolSize) {
    NewKlass.poolSize = DEFAULT_POOL_SIZE;
  }
  NewKlass.release = standardReleaser;
  return NewKlass;
};

var PooledClass = {
  addPoolingTo: addPoolingTo,
  oneArgumentPooler: oneArgumentPooler,
  twoArgumentPooler: twoArgumentPooler,
  threeArgumentPooler: threeArgumentPooler,
  fiveArgumentPooler: fiveArgumentPooler
};

module.exports = PooledClass;

}).call(this,require('_process'))
},{"./invariant":126,"_process":152}],28:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule React
 */

"use strict";

var DOMPropertyOperations = require("./DOMPropertyOperations");
var EventPluginUtils = require("./EventPluginUtils");
var ReactChildren = require("./ReactChildren");
var ReactComponent = require("./ReactComponent");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactContext = require("./ReactContext");
var ReactCurrentOwner = require("./ReactCurrentOwner");
var ReactElement = require("./ReactElement");
var ReactElementValidator = require("./ReactElementValidator");
var ReactDOM = require("./ReactDOM");
var ReactDOMComponent = require("./ReactDOMComponent");
var ReactDefaultInjection = require("./ReactDefaultInjection");
var ReactInstanceHandles = require("./ReactInstanceHandles");
var ReactLegacyElement = require("./ReactLegacyElement");
var ReactMount = require("./ReactMount");
var ReactMultiChild = require("./ReactMultiChild");
var ReactPerf = require("./ReactPerf");
var ReactPropTypes = require("./ReactPropTypes");
var ReactServerRendering = require("./ReactServerRendering");
var ReactTextComponent = require("./ReactTextComponent");

var assign = require("./Object.assign");
var deprecated = require("./deprecated");
var onlyChild = require("./onlyChild");

ReactDefaultInjection.inject();

var createElement = ReactElement.createElement;
var createFactory = ReactElement.createFactory;

if ("production" !== process.env.NODE_ENV) {
  createElement = ReactElementValidator.createElement;
  createFactory = ReactElementValidator.createFactory;
}

// TODO: Drop legacy elements once classes no longer export these factories
createElement = ReactLegacyElement.wrapCreateElement(
  createElement
);
createFactory = ReactLegacyElement.wrapCreateFactory(
  createFactory
);

var render = ReactPerf.measure('React', 'render', ReactMount.render);

var React = {
  Children: {
    map: ReactChildren.map,
    forEach: ReactChildren.forEach,
    count: ReactChildren.count,
    only: onlyChild
  },
  DOM: ReactDOM,
  PropTypes: ReactPropTypes,
  initializeTouchEvents: function(shouldUseTouch) {
    EventPluginUtils.useTouchEvents = shouldUseTouch;
  },
  createClass: ReactCompositeComponent.createClass,
  createElement: createElement,
  createFactory: createFactory,
  constructAndRenderComponent: ReactMount.constructAndRenderComponent,
  constructAndRenderComponentByID: ReactMount.constructAndRenderComponentByID,
  render: render,
  renderToString: ReactServerRendering.renderToString,
  renderToStaticMarkup: ReactServerRendering.renderToStaticMarkup,
  unmountComponentAtNode: ReactMount.unmountComponentAtNode,
  isValidClass: ReactLegacyElement.isValidClass,
  isValidElement: ReactElement.isValidElement,
  withContext: ReactContext.withContext,

  // Hook for JSX spread, don't use this for anything else.
  __spread: assign,

  // Deprecations (remove for 0.13)
  renderComponent: deprecated(
    'React',
    'renderComponent',
    'render',
    this,
    render
  ),
  renderComponentToString: deprecated(
    'React',
    'renderComponentToString',
    'renderToString',
    this,
    ReactServerRendering.renderToString
  ),
  renderComponentToStaticMarkup: deprecated(
    'React',
    'renderComponentToStaticMarkup',
    'renderToStaticMarkup',
    this,
    ReactServerRendering.renderToStaticMarkup
  ),
  isValidComponent: deprecated(
    'React',
    'isValidComponent',
    'isValidElement',
    this,
    ReactElement.isValidElement
  )
};

// Inject the runtime into a devtools global hook regardless of browser.
// Allows for debugging when the hook is injected on the page.
if (
  typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' &&
  typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.inject === 'function') {
  __REACT_DEVTOOLS_GLOBAL_HOOK__.inject({
    Component: ReactComponent,
    CurrentOwner: ReactCurrentOwner,
    DOMComponent: ReactDOMComponent,
    DOMPropertyOperations: DOMPropertyOperations,
    InstanceHandles: ReactInstanceHandles,
    Mount: ReactMount,
    MultiChild: ReactMultiChild,
    TextComponent: ReactTextComponent
  });
}

if ("production" !== process.env.NODE_ENV) {
  var ExecutionEnvironment = require("./ExecutionEnvironment");
  if (ExecutionEnvironment.canUseDOM && window.top === window.self) {

    // If we're in Chrome, look for the devtools marker and provide a download
    // link if not installed.
    if (navigator.userAgent.indexOf('Chrome') > -1) {
      if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ === 'undefined') {
        console.debug(
          'Download the React DevTools for a better development experience: ' +
          'http://fb.me/react-devtools'
        );
      }
    }

    var expectedFeatures = [
      // shims
      Array.isArray,
      Array.prototype.every,
      Array.prototype.forEach,
      Array.prototype.indexOf,
      Array.prototype.map,
      Date.now,
      Function.prototype.bind,
      Object.keys,
      String.prototype.split,
      String.prototype.trim,

      // shams
      Object.create,
      Object.freeze
    ];

    for (var i = 0; i < expectedFeatures.length; i++) {
      if (!expectedFeatures[i]) {
        console.error(
          'One or more ES5 shim/shams expected by React are not available: ' +
          'http://fb.me/react-warning-polyfills'
        );
        break;
      }
    }
  }
}

// Version exists only in the open-source version of React, not in Facebook's
// internal version.
React.version = '0.12.1';

module.exports = React;

}).call(this,require('_process'))
},{"./DOMPropertyOperations":11,"./EventPluginUtils":19,"./ExecutionEnvironment":21,"./Object.assign":26,"./ReactChildren":31,"./ReactComponent":32,"./ReactCompositeComponent":34,"./ReactContext":35,"./ReactCurrentOwner":36,"./ReactDOM":37,"./ReactDOMComponent":39,"./ReactDefaultInjection":49,"./ReactElement":52,"./ReactElementValidator":53,"./ReactInstanceHandles":60,"./ReactLegacyElement":61,"./ReactMount":63,"./ReactMultiChild":64,"./ReactPerf":68,"./ReactPropTypes":72,"./ReactServerRendering":76,"./ReactTextComponent":78,"./deprecated":106,"./onlyChild":137,"_process":152}],29:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactBrowserComponentMixin
 */

"use strict";

var ReactEmptyComponent = require("./ReactEmptyComponent");
var ReactMount = require("./ReactMount");

var invariant = require("./invariant");

var ReactBrowserComponentMixin = {
  /**
   * Returns the DOM node rendered by this component.
   *
   * @return {DOMElement} The root node of this component.
   * @final
   * @protected
   */
  getDOMNode: function() {
    ("production" !== process.env.NODE_ENV ? invariant(
      this.isMounted(),
      'getDOMNode(): A component must be mounted to have a DOM node.'
    ) : invariant(this.isMounted()));
    if (ReactEmptyComponent.isNullComponentID(this._rootNodeID)) {
      return null;
    }
    return ReactMount.getNode(this._rootNodeID);
  }
};

module.exports = ReactBrowserComponentMixin;

}).call(this,require('_process'))
},{"./ReactEmptyComponent":54,"./ReactMount":63,"./invariant":126,"_process":152}],30:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactBrowserEventEmitter
 * @typechecks static-only
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPluginHub = require("./EventPluginHub");
var EventPluginRegistry = require("./EventPluginRegistry");
var ReactEventEmitterMixin = require("./ReactEventEmitterMixin");
var ViewportMetrics = require("./ViewportMetrics");

var assign = require("./Object.assign");
var isEventSupported = require("./isEventSupported");

/**
 * Summary of `ReactBrowserEventEmitter` event handling:
 *
 *  - Top-level delegation is used to trap most native browser events. This
 *    may only occur in the main thread and is the responsibility of
 *    ReactEventListener, which is injected and can therefore support pluggable
 *    event sources. This is the only work that occurs in the main thread.
 *
 *  - We normalize and de-duplicate events to account for browser quirks. This
 *    may be done in the worker thread.
 *
 *  - Forward these native events (with the associated top-level type used to
 *    trap it) to `EventPluginHub`, which in turn will ask plugins if they want
 *    to extract any synthetic events.
 *
 *  - The `EventPluginHub` will then process each event by annotating them with
 *    "dispatches", a sequence of listeners and IDs that care about that event.
 *
 *  - The `EventPluginHub` then dispatches the events.
 *
 * Overview of React and the event system:
 *
 * +------------+    .
 * |    DOM     |    .
 * +------------+    .
 *       |           .
 *       v           .
 * +------------+    .
 * | ReactEvent |    .
 * |  Listener  |    .
 * +------------+    .                         +-----------+
 *       |           .               +--------+|SimpleEvent|
 *       |           .               |         |Plugin     |
 * +-----|------+    .               v         +-----------+
 * |     |      |    .    +--------------+                    +------------+
 * |     +-----------.--->|EventPluginHub|                    |    Event   |
 * |            |    .    |              |     +-----------+  | Propagators|
 * | ReactEvent |    .    |              |     |TapEvent   |  |------------|
 * |  Emitter   |    .    |              |<---+|Plugin     |  |other plugin|
 * |            |    .    |              |     +-----------+  |  utilities |
 * |     +-----------.--->|              |                    +------------+
 * |     |      |    .    +--------------+
 * +-----|------+    .                ^        +-----------+
 *       |           .                |        |Enter/Leave|
 *       +           .                +-------+|Plugin     |
 * +-------------+   .                         +-----------+
 * | application |   .
 * |-------------|   .
 * |             |   .
 * |             |   .
 * +-------------+   .
 *                   .
 *    React Core     .  General Purpose Event Plugin System
 */

var alreadyListeningTo = {};
var isMonitoringScrollValue = false;
var reactTopListenersCounter = 0;

// For events like 'submit' which don't consistently bubble (which we trap at a
// lower node than `document`), binding at `document` would cause duplicate
// events so we don't include them here
var topEventMapping = {
  topBlur: 'blur',
  topChange: 'change',
  topClick: 'click',
  topCompositionEnd: 'compositionend',
  topCompositionStart: 'compositionstart',
  topCompositionUpdate: 'compositionupdate',
  topContextMenu: 'contextmenu',
  topCopy: 'copy',
  topCut: 'cut',
  topDoubleClick: 'dblclick',
  topDrag: 'drag',
  topDragEnd: 'dragend',
  topDragEnter: 'dragenter',
  topDragExit: 'dragexit',
  topDragLeave: 'dragleave',
  topDragOver: 'dragover',
  topDragStart: 'dragstart',
  topDrop: 'drop',
  topFocus: 'focus',
  topInput: 'input',
  topKeyDown: 'keydown',
  topKeyPress: 'keypress',
  topKeyUp: 'keyup',
  topMouseDown: 'mousedown',
  topMouseMove: 'mousemove',
  topMouseOut: 'mouseout',
  topMouseOver: 'mouseover',
  topMouseUp: 'mouseup',
  topPaste: 'paste',
  topScroll: 'scroll',
  topSelectionChange: 'selectionchange',
  topTextInput: 'textInput',
  topTouchCancel: 'touchcancel',
  topTouchEnd: 'touchend',
  topTouchMove: 'touchmove',
  topTouchStart: 'touchstart',
  topWheel: 'wheel'
};

/**
 * To ensure no conflicts with other potential React instances on the page
 */
var topListenersIDKey = "_reactListenersID" + String(Math.random()).slice(2);

function getListeningForDocument(mountAt) {
  // In IE8, `mountAt` is a host object and doesn't have `hasOwnProperty`
  // directly.
  if (!Object.prototype.hasOwnProperty.call(mountAt, topListenersIDKey)) {
    mountAt[topListenersIDKey] = reactTopListenersCounter++;
    alreadyListeningTo[mountAt[topListenersIDKey]] = {};
  }
  return alreadyListeningTo[mountAt[topListenersIDKey]];
}

/**
 * `ReactBrowserEventEmitter` is used to attach top-level event listeners. For
 * example:
 *
 *   ReactBrowserEventEmitter.putListener('myID', 'onClick', myFunction);
 *
 * This would allocate a "registration" of `('onClick', myFunction)` on 'myID'.
 *
 * @internal
 */
var ReactBrowserEventEmitter = assign({}, ReactEventEmitterMixin, {

  /**
   * Injectable event backend
   */
  ReactEventListener: null,

  injection: {
    /**
     * @param {object} ReactEventListener
     */
    injectReactEventListener: function(ReactEventListener) {
      ReactEventListener.setHandleTopLevel(
        ReactBrowserEventEmitter.handleTopLevel
      );
      ReactBrowserEventEmitter.ReactEventListener = ReactEventListener;
    }
  },

  /**
   * Sets whether or not any created callbacks should be enabled.
   *
   * @param {boolean} enabled True if callbacks should be enabled.
   */
  setEnabled: function(enabled) {
    if (ReactBrowserEventEmitter.ReactEventListener) {
      ReactBrowserEventEmitter.ReactEventListener.setEnabled(enabled);
    }
  },

  /**
   * @return {boolean} True if callbacks are enabled.
   */
  isEnabled: function() {
    return !!(
      ReactBrowserEventEmitter.ReactEventListener &&
      ReactBrowserEventEmitter.ReactEventListener.isEnabled()
    );
  },

  /**
   * We listen for bubbled touch events on the document object.
   *
   * Firefox v8.01 (and possibly others) exhibited strange behavior when
   * mounting `onmousemove` events at some node that was not the document
   * element. The symptoms were that if your mouse is not moving over something
   * contained within that mount point (for example on the background) the
   * top-level listeners for `onmousemove` won't be called. However, if you
   * register the `mousemove` on the document object, then it will of course
   * catch all `mousemove`s. This along with iOS quirks, justifies restricting
   * top-level listeners to the document object only, at least for these
   * movement types of events and possibly all events.
   *
   * @see http://www.quirksmode.org/blog/archives/2010/09/click_event_del.html
   *
   * Also, `keyup`/`keypress`/`keydown` do not bubble to the window on IE, but
   * they bubble to document.
   *
   * @param {string} registrationName Name of listener (e.g. `onClick`).
   * @param {object} contentDocumentHandle Document which owns the container
   */
  listenTo: function(registrationName, contentDocumentHandle) {
    var mountAt = contentDocumentHandle;
    var isListening = getListeningForDocument(mountAt);
    var dependencies = EventPluginRegistry.
      registrationNameDependencies[registrationName];

    var topLevelTypes = EventConstants.topLevelTypes;
    for (var i = 0, l = dependencies.length; i < l; i++) {
      var dependency = dependencies[i];
      if (!(
            isListening.hasOwnProperty(dependency) &&
            isListening[dependency]
          )) {
        if (dependency === topLevelTypes.topWheel) {
          if (isEventSupported('wheel')) {
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topWheel,
              'wheel',
              mountAt
            );
          } else if (isEventSupported('mousewheel')) {
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topWheel,
              'mousewheel',
              mountAt
            );
          } else {
            // Firefox needs to capture a different mouse scroll event.
            // @see http://www.quirksmode.org/dom/events/tests/scroll.html
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topWheel,
              'DOMMouseScroll',
              mountAt
            );
          }
        } else if (dependency === topLevelTypes.topScroll) {

          if (isEventSupported('scroll', true)) {
            ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
              topLevelTypes.topScroll,
              'scroll',
              mountAt
            );
          } else {
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topScroll,
              'scroll',
              ReactBrowserEventEmitter.ReactEventListener.WINDOW_HANDLE
            );
          }
        } else if (dependency === topLevelTypes.topFocus ||
            dependency === topLevelTypes.topBlur) {

          if (isEventSupported('focus', true)) {
            ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
              topLevelTypes.topFocus,
              'focus',
              mountAt
            );
            ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
              topLevelTypes.topBlur,
              'blur',
              mountAt
            );
          } else if (isEventSupported('focusin')) {
            // IE has `focusin` and `focusout` events which bubble.
            // @see http://www.quirksmode.org/blog/archives/2008/04/delegating_the.html
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topFocus,
              'focusin',
              mountAt
            );
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topBlur,
              'focusout',
              mountAt
            );
          }

          // to make sure blur and focus event listeners are only attached once
          isListening[topLevelTypes.topBlur] = true;
          isListening[topLevelTypes.topFocus] = true;
        } else if (topEventMapping.hasOwnProperty(dependency)) {
          ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
            dependency,
            topEventMapping[dependency],
            mountAt
          );
        }

        isListening[dependency] = true;
      }
    }
  },

  trapBubbledEvent: function(topLevelType, handlerBaseName, handle) {
    return ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
      topLevelType,
      handlerBaseName,
      handle
    );
  },

  trapCapturedEvent: function(topLevelType, handlerBaseName, handle) {
    return ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
      topLevelType,
      handlerBaseName,
      handle
    );
  },

  /**
   * Listens to window scroll and resize events. We cache scroll values so that
   * application code can access them without triggering reflows.
   *
   * NOTE: Scroll events do not bubble.
   *
   * @see http://www.quirksmode.org/dom/events/scroll.html
   */
  ensureScrollValueMonitoring: function(){
    if (!isMonitoringScrollValue) {
      var refresh = ViewportMetrics.refreshScrollValues;
      ReactBrowserEventEmitter.ReactEventListener.monitorScrollValue(refresh);
      isMonitoringScrollValue = true;
    }
  },

  eventNameDispatchConfigs: EventPluginHub.eventNameDispatchConfigs,

  registrationNameModules: EventPluginHub.registrationNameModules,

  putListener: EventPluginHub.putListener,

  getListener: EventPluginHub.getListener,

  deleteListener: EventPluginHub.deleteListener,

  deleteAllListeners: EventPluginHub.deleteAllListeners

});

module.exports = ReactBrowserEventEmitter;

},{"./EventConstants":15,"./EventPluginHub":17,"./EventPluginRegistry":18,"./Object.assign":26,"./ReactEventEmitterMixin":56,"./ViewportMetrics":96,"./isEventSupported":127}],31:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactChildren
 */

"use strict";

var PooledClass = require("./PooledClass");

var traverseAllChildren = require("./traverseAllChildren");
var warning = require("./warning");

var twoArgumentPooler = PooledClass.twoArgumentPooler;
var threeArgumentPooler = PooledClass.threeArgumentPooler;

/**
 * PooledClass representing the bookkeeping associated with performing a child
 * traversal. Allows avoiding binding callbacks.
 *
 * @constructor ForEachBookKeeping
 * @param {!function} forEachFunction Function to perform traversal with.
 * @param {?*} forEachContext Context to perform context with.
 */
function ForEachBookKeeping(forEachFunction, forEachContext) {
  this.forEachFunction = forEachFunction;
  this.forEachContext = forEachContext;
}
PooledClass.addPoolingTo(ForEachBookKeeping, twoArgumentPooler);

function forEachSingleChild(traverseContext, child, name, i) {
  var forEachBookKeeping = traverseContext;
  forEachBookKeeping.forEachFunction.call(
    forEachBookKeeping.forEachContext, child, i);
}

/**
 * Iterates through children that are typically specified as `props.children`.
 *
 * The provided forEachFunc(child, index) will be called for each
 * leaf child.
 *
 * @param {?*} children Children tree container.
 * @param {function(*, int)} forEachFunc.
 * @param {*} forEachContext Context for forEachContext.
 */
function forEachChildren(children, forEachFunc, forEachContext) {
  if (children == null) {
    return children;
  }

  var traverseContext =
    ForEachBookKeeping.getPooled(forEachFunc, forEachContext);
  traverseAllChildren(children, forEachSingleChild, traverseContext);
  ForEachBookKeeping.release(traverseContext);
}

/**
 * PooledClass representing the bookkeeping associated with performing a child
 * mapping. Allows avoiding binding callbacks.
 *
 * @constructor MapBookKeeping
 * @param {!*} mapResult Object containing the ordered map of results.
 * @param {!function} mapFunction Function to perform mapping with.
 * @param {?*} mapContext Context to perform mapping with.
 */
function MapBookKeeping(mapResult, mapFunction, mapContext) {
  this.mapResult = mapResult;
  this.mapFunction = mapFunction;
  this.mapContext = mapContext;
}
PooledClass.addPoolingTo(MapBookKeeping, threeArgumentPooler);

function mapSingleChildIntoContext(traverseContext, child, name, i) {
  var mapBookKeeping = traverseContext;
  var mapResult = mapBookKeeping.mapResult;

  var keyUnique = !mapResult.hasOwnProperty(name);
  ("production" !== process.env.NODE_ENV ? warning(
    keyUnique,
    'ReactChildren.map(...): Encountered two children with the same key, ' +
    '`%s`. Child keys must be unique; when two children share a key, only ' +
    'the first child will be used.',
    name
  ) : null);

  if (keyUnique) {
    var mappedChild =
      mapBookKeeping.mapFunction.call(mapBookKeeping.mapContext, child, i);
    mapResult[name] = mappedChild;
  }
}

/**
 * Maps children that are typically specified as `props.children`.
 *
 * The provided mapFunction(child, key, index) will be called for each
 * leaf child.
 *
 * TODO: This may likely break any calls to `ReactChildren.map` that were
 * previously relying on the fact that we guarded against null children.
 *
 * @param {?*} children Children tree container.
 * @param {function(*, int)} mapFunction.
 * @param {*} mapContext Context for mapFunction.
 * @return {object} Object containing the ordered map of results.
 */
function mapChildren(children, func, context) {
  if (children == null) {
    return children;
  }

  var mapResult = {};
  var traverseContext = MapBookKeeping.getPooled(mapResult, func, context);
  traverseAllChildren(children, mapSingleChildIntoContext, traverseContext);
  MapBookKeeping.release(traverseContext);
  return mapResult;
}

function forEachSingleChildDummy(traverseContext, child, name, i) {
  return null;
}

/**
 * Count the number of children that are typically specified as
 * `props.children`.
 *
 * @param {?*} children Children tree container.
 * @return {number} The number of children.
 */
function countChildren(children, context) {
  return traverseAllChildren(children, forEachSingleChildDummy, null);
}

var ReactChildren = {
  forEach: forEachChildren,
  map: mapChildren,
  count: countChildren
};

module.exports = ReactChildren;

}).call(this,require('_process'))
},{"./PooledClass":27,"./traverseAllChildren":144,"./warning":145,"_process":152}],32:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactComponent
 */

"use strict";

var ReactElement = require("./ReactElement");
var ReactOwner = require("./ReactOwner");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");
var invariant = require("./invariant");
var keyMirror = require("./keyMirror");

/**
 * Every React component is in one of these life cycles.
 */
var ComponentLifeCycle = keyMirror({
  /**
   * Mounted components have a DOM node representation and are capable of
   * receiving new props.
   */
  MOUNTED: null,
  /**
   * Unmounted components are inactive and cannot receive new props.
   */
  UNMOUNTED: null
});

var injected = false;

/**
 * Optionally injectable environment dependent cleanup hook. (server vs.
 * browser etc). Example: A browser system caches DOM nodes based on component
 * ID and must remove that cache entry when this instance is unmounted.
 *
 * @private
 */
var unmountIDFromEnvironment = null;

/**
 * The "image" of a component tree, is the platform specific (typically
 * serialized) data that represents a tree of lower level UI building blocks.
 * On the web, this "image" is HTML markup which describes a construction of
 * low level `div` and `span` nodes. Other platforms may have different
 * encoding of this "image". This must be injected.
 *
 * @private
 */
var mountImageIntoNode = null;

/**
 * Components are the basic units of composition in React.
 *
 * Every component accepts a set of keyed input parameters known as "props" that
 * are initialized by the constructor. Once a component is mounted, the props
 * can be mutated using `setProps` or `replaceProps`.
 *
 * Every component is capable of the following operations:
 *
 *   `mountComponent`
 *     Initializes the component, renders markup, and registers event listeners.
 *
 *   `receiveComponent`
 *     Updates the rendered DOM nodes to match the given component.
 *
 *   `unmountComponent`
 *     Releases any resources allocated by this component.
 *
 * Components can also be "owned" by other components. Being owned by another
 * component means being constructed by that component. This is different from
 * being the child of a component, which means having a DOM representation that
 * is a child of the DOM representation of that component.
 *
 * @class ReactComponent
 */
var ReactComponent = {

  injection: {
    injectEnvironment: function(ReactComponentEnvironment) {
      ("production" !== process.env.NODE_ENV ? invariant(
        !injected,
        'ReactComponent: injectEnvironment() can only be called once.'
      ) : invariant(!injected));
      mountImageIntoNode = ReactComponentEnvironment.mountImageIntoNode;
      unmountIDFromEnvironment =
        ReactComponentEnvironment.unmountIDFromEnvironment;
      ReactComponent.BackendIDOperations =
        ReactComponentEnvironment.BackendIDOperations;
      injected = true;
    }
  },

  /**
   * @internal
   */
  LifeCycle: ComponentLifeCycle,

  /**
   * Injected module that provides ability to mutate individual properties.
   * Injected into the base class because many different subclasses need access
   * to this.
   *
   * @internal
   */
  BackendIDOperations: null,

  /**
   * Base functionality for every ReactComponent constructor. Mixed into the
   * `ReactComponent` prototype, but exposed statically for easy access.
   *
   * @lends {ReactComponent.prototype}
   */
  Mixin: {

    /**
     * Checks whether or not this component is mounted.
     *
     * @return {boolean} True if mounted, false otherwise.
     * @final
     * @protected
     */
    isMounted: function() {
      return this._lifeCycleState === ComponentLifeCycle.MOUNTED;
    },

    /**
     * Sets a subset of the props.
     *
     * @param {object} partialProps Subset of the next props.
     * @param {?function} callback Called after props are updated.
     * @final
     * @public
     */
    setProps: function(partialProps, callback) {
      // Merge with the pending element if it exists, otherwise with existing
      // element props.
      var element = this._pendingElement || this._currentElement;
      this.replaceProps(
        assign({}, element.props, partialProps),
        callback
      );
    },

    /**
     * Replaces all of the props.
     *
     * @param {object} props New props.
     * @param {?function} callback Called after props are updated.
     * @final
     * @public
     */
    replaceProps: function(props, callback) {
      ("production" !== process.env.NODE_ENV ? invariant(
        this.isMounted(),
        'replaceProps(...): Can only update a mounted component.'
      ) : invariant(this.isMounted()));
      ("production" !== process.env.NODE_ENV ? invariant(
        this._mountDepth === 0,
        'replaceProps(...): You called `setProps` or `replaceProps` on a ' +
        'component with a parent. This is an anti-pattern since props will ' +
        'get reactively updated when rendered. Instead, change the owner\'s ' +
        '`render` method to pass the correct value as props to the component ' +
        'where it is created.'
      ) : invariant(this._mountDepth === 0));
      // This is a deoptimized path. We optimize for always having a element.
      // This creates an extra internal element.
      this._pendingElement = ReactElement.cloneAndReplaceProps(
        this._pendingElement || this._currentElement,
        props
      );
      ReactUpdates.enqueueUpdate(this, callback);
    },

    /**
     * Schedule a partial update to the props. Only used for internal testing.
     *
     * @param {object} partialProps Subset of the next props.
     * @param {?function} callback Called after props are updated.
     * @final
     * @internal
     */
    _setPropsInternal: function(partialProps, callback) {
      // This is a deoptimized path. We optimize for always having a element.
      // This creates an extra internal element.
      var element = this._pendingElement || this._currentElement;
      this._pendingElement = ReactElement.cloneAndReplaceProps(
        element,
        assign({}, element.props, partialProps)
      );
      ReactUpdates.enqueueUpdate(this, callback);
    },

    /**
     * Base constructor for all React components.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.construct.call(this, ...)`.
     *
     * @param {ReactElement} element
     * @internal
     */
    construct: function(element) {
      // This is the public exposed props object after it has been processed
      // with default props. The element's props represents the true internal
      // state of the props.
      this.props = element.props;
      // Record the component responsible for creating this component.
      // This is accessible through the element but we maintain an extra
      // field for compatibility with devtools and as a way to make an
      // incremental update. TODO: Consider deprecating this field.
      this._owner = element._owner;

      // All components start unmounted.
      this._lifeCycleState = ComponentLifeCycle.UNMOUNTED;

      // See ReactUpdates.
      this._pendingCallbacks = null;

      // We keep the old element and a reference to the pending element
      // to track updates.
      this._currentElement = element;
      this._pendingElement = null;
    },

    /**
     * Initializes the component, renders markup, and registers event listeners.
     *
     * NOTE: This does not insert any nodes into the DOM.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.mountComponent.call(this, ...)`.
     *
     * @param {string} rootID DOM ID of the root node.
     * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
     * @param {number} mountDepth number of components in the owner hierarchy.
     * @return {?string} Rendered markup to be inserted into the DOM.
     * @internal
     */
    mountComponent: function(rootID, transaction, mountDepth) {
      ("production" !== process.env.NODE_ENV ? invariant(
        !this.isMounted(),
        'mountComponent(%s, ...): Can only mount an unmounted component. ' +
        'Make sure to avoid storing components between renders or reusing a ' +
        'single component instance in multiple places.',
        rootID
      ) : invariant(!this.isMounted()));
      var ref = this._currentElement.ref;
      if (ref != null) {
        var owner = this._currentElement._owner;
        ReactOwner.addComponentAsRefTo(this, ref, owner);
      }
      this._rootNodeID = rootID;
      this._lifeCycleState = ComponentLifeCycle.MOUNTED;
      this._mountDepth = mountDepth;
      // Effectively: return '';
    },

    /**
     * Releases any resources allocated by `mountComponent`.
     *
     * NOTE: This does not remove any nodes from the DOM.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.unmountComponent.call(this)`.
     *
     * @internal
     */
    unmountComponent: function() {
      ("production" !== process.env.NODE_ENV ? invariant(
        this.isMounted(),
        'unmountComponent(): Can only unmount a mounted component.'
      ) : invariant(this.isMounted()));
      var ref = this._currentElement.ref;
      if (ref != null) {
        ReactOwner.removeComponentAsRefFrom(this, ref, this._owner);
      }
      unmountIDFromEnvironment(this._rootNodeID);
      this._rootNodeID = null;
      this._lifeCycleState = ComponentLifeCycle.UNMOUNTED;
    },

    /**
     * Given a new instance of this component, updates the rendered DOM nodes
     * as if that instance was rendered instead.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.receiveComponent.call(this, ...)`.
     *
     * @param {object} nextComponent Next set of properties.
     * @param {ReactReconcileTransaction} transaction
     * @internal
     */
    receiveComponent: function(nextElement, transaction) {
      ("production" !== process.env.NODE_ENV ? invariant(
        this.isMounted(),
        'receiveComponent(...): Can only update a mounted component.'
      ) : invariant(this.isMounted()));
      this._pendingElement = nextElement;
      this.performUpdateIfNecessary(transaction);
    },

    /**
     * If `_pendingElement` is set, update the component.
     *
     * @param {ReactReconcileTransaction} transaction
     * @internal
     */
    performUpdateIfNecessary: function(transaction) {
      if (this._pendingElement == null) {
        return;
      }
      var prevElement = this._currentElement;
      var nextElement = this._pendingElement;
      this._currentElement = nextElement;
      this.props = nextElement.props;
      this._owner = nextElement._owner;
      this._pendingElement = null;
      this.updateComponent(transaction, prevElement);
    },

    /**
     * Updates the component's currently mounted representation.
     *
     * @param {ReactReconcileTransaction} transaction
     * @param {object} prevElement
     * @internal
     */
    updateComponent: function(transaction, prevElement) {
      var nextElement = this._currentElement;

      // If either the owner or a `ref` has changed, make sure the newest owner
      // has stored a reference to `this`, and the previous owner (if different)
      // has forgotten the reference to `this`. We use the element instead
      // of the public this.props because the post processing cannot determine
      // a ref. The ref conceptually lives on the element.

      // TODO: Should this even be possible? The owner cannot change because
      // it's forbidden by shouldUpdateReactComponent. The ref can change
      // if you swap the keys of but not the refs. Reconsider where this check
      // is made. It probably belongs where the key checking and
      // instantiateReactComponent is done.

      if (nextElement._owner !== prevElement._owner ||
          nextElement.ref !== prevElement.ref) {
        if (prevElement.ref != null) {
          ReactOwner.removeComponentAsRefFrom(
            this, prevElement.ref, prevElement._owner
          );
        }
        // Correct, even if the owner is the same, and only the ref has changed.
        if (nextElement.ref != null) {
          ReactOwner.addComponentAsRefTo(
            this,
            nextElement.ref,
            nextElement._owner
          );
        }
      }
    },

    /**
     * Mounts this component and inserts it into the DOM.
     *
     * @param {string} rootID DOM ID of the root node.
     * @param {DOMElement} container DOM element to mount into.
     * @param {boolean} shouldReuseMarkup If true, do not insert markup
     * @final
     * @internal
     * @see {ReactMount.render}
     */
    mountComponentIntoNode: function(rootID, container, shouldReuseMarkup) {
      var transaction = ReactUpdates.ReactReconcileTransaction.getPooled();
      transaction.perform(
        this._mountComponentIntoNode,
        this,
        rootID,
        container,
        transaction,
        shouldReuseMarkup
      );
      ReactUpdates.ReactReconcileTransaction.release(transaction);
    },

    /**
     * @param {string} rootID DOM ID of the root node.
     * @param {DOMElement} container DOM element to mount into.
     * @param {ReactReconcileTransaction} transaction
     * @param {boolean} shouldReuseMarkup If true, do not insert markup
     * @final
     * @private
     */
    _mountComponentIntoNode: function(
        rootID,
        container,
        transaction,
        shouldReuseMarkup) {
      var markup = this.mountComponent(rootID, transaction, 0);
      mountImageIntoNode(markup, container, shouldReuseMarkup);
    },

    /**
     * Checks if this component is owned by the supplied `owner` component.
     *
     * @param {ReactComponent} owner Component to check.
     * @return {boolean} True if `owners` owns this component.
     * @final
     * @internal
     */
    isOwnedBy: function(owner) {
      return this._owner === owner;
    },

    /**
     * Gets another component, that shares the same owner as this one, by ref.
     *
     * @param {string} ref of a sibling Component.
     * @return {?ReactComponent} the actual sibling Component.
     * @final
     * @internal
     */
    getSiblingByRef: function(ref) {
      var owner = this._owner;
      if (!owner || !owner.refs) {
        return null;
      }
      return owner.refs[ref];
    }
  }
};

module.exports = ReactComponent;

}).call(this,require('_process'))
},{"./Object.assign":26,"./ReactElement":52,"./ReactOwner":67,"./ReactUpdates":79,"./invariant":126,"./keyMirror":132,"_process":152}],33:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactComponentBrowserEnvironment
 */

/*jslint evil: true */

"use strict";

var ReactDOMIDOperations = require("./ReactDOMIDOperations");
var ReactMarkupChecksum = require("./ReactMarkupChecksum");
var ReactMount = require("./ReactMount");
var ReactPerf = require("./ReactPerf");
var ReactReconcileTransaction = require("./ReactReconcileTransaction");

var getReactRootElementInContainer = require("./getReactRootElementInContainer");
var invariant = require("./invariant");
var setInnerHTML = require("./setInnerHTML");


var ELEMENT_NODE_TYPE = 1;
var DOC_NODE_TYPE = 9;


/**
 * Abstracts away all functionality of `ReactComponent` requires knowledge of
 * the browser context.
 */
var ReactComponentBrowserEnvironment = {
  ReactReconcileTransaction: ReactReconcileTransaction,

  BackendIDOperations: ReactDOMIDOperations,

  /**
   * If a particular environment requires that some resources be cleaned up,
   * specify this in the injected Mixin. In the DOM, we would likely want to
   * purge any cached node ID lookups.
   *
   * @private
   */
  unmountIDFromEnvironment: function(rootNodeID) {
    ReactMount.purgeID(rootNodeID);
  },

  /**
   * @param {string} markup Markup string to place into the DOM Element.
   * @param {DOMElement} container DOM Element to insert markup into.
   * @param {boolean} shouldReuseMarkup Should reuse the existing markup in the
   * container if possible.
   */
  mountImageIntoNode: ReactPerf.measure(
    'ReactComponentBrowserEnvironment',
    'mountImageIntoNode',
    function(markup, container, shouldReuseMarkup) {
      ("production" !== process.env.NODE_ENV ? invariant(
        container && (
          container.nodeType === ELEMENT_NODE_TYPE ||
            container.nodeType === DOC_NODE_TYPE
        ),
        'mountComponentIntoNode(...): Target container is not valid.'
      ) : invariant(container && (
        container.nodeType === ELEMENT_NODE_TYPE ||
          container.nodeType === DOC_NODE_TYPE
      )));

      if (shouldReuseMarkup) {
        if (ReactMarkupChecksum.canReuseMarkup(
          markup,
          getReactRootElementInContainer(container))) {
          return;
        } else {
          ("production" !== process.env.NODE_ENV ? invariant(
            container.nodeType !== DOC_NODE_TYPE,
            'You\'re trying to render a component to the document using ' +
            'server rendering but the checksum was invalid. This usually ' +
            'means you rendered a different component type or props on ' +
            'the client from the one on the server, or your render() ' +
            'methods are impure. React cannot handle this case due to ' +
            'cross-browser quirks by rendering at the document root. You ' +
            'should look for environment dependent code in your components ' +
            'and ensure the props are the same client and server side.'
          ) : invariant(container.nodeType !== DOC_NODE_TYPE));

          if ("production" !== process.env.NODE_ENV) {
            console.warn(
              'React attempted to use reuse markup in a container but the ' +
              'checksum was invalid. This generally means that you are ' +
              'using server rendering and the markup generated on the ' +
              'server was not what the client was expecting. React injected ' +
              'new markup to compensate which works but you have lost many ' +
              'of the benefits of server rendering. Instead, figure out ' +
              'why the markup being generated is different on the client ' +
              'or server.'
            );
          }
        }
      }

      ("production" !== process.env.NODE_ENV ? invariant(
        container.nodeType !== DOC_NODE_TYPE,
        'You\'re trying to render a component to the document but ' +
          'you didn\'t use server rendering. We can\'t do this ' +
          'without using server rendering due to cross-browser quirks. ' +
          'See renderComponentToString() for server rendering.'
      ) : invariant(container.nodeType !== DOC_NODE_TYPE));

      setInnerHTML(container, markup);
    }
  )
};

module.exports = ReactComponentBrowserEnvironment;

}).call(this,require('_process'))
},{"./ReactDOMIDOperations":41,"./ReactMarkupChecksum":62,"./ReactMount":63,"./ReactPerf":68,"./ReactReconcileTransaction":74,"./getReactRootElementInContainer":120,"./invariant":126,"./setInnerHTML":140,"_process":152}],34:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactCompositeComponent
 */

"use strict";

var ReactComponent = require("./ReactComponent");
var ReactContext = require("./ReactContext");
var ReactCurrentOwner = require("./ReactCurrentOwner");
var ReactElement = require("./ReactElement");
var ReactElementValidator = require("./ReactElementValidator");
var ReactEmptyComponent = require("./ReactEmptyComponent");
var ReactErrorUtils = require("./ReactErrorUtils");
var ReactLegacyElement = require("./ReactLegacyElement");
var ReactOwner = require("./ReactOwner");
var ReactPerf = require("./ReactPerf");
var ReactPropTransferer = require("./ReactPropTransferer");
var ReactPropTypeLocations = require("./ReactPropTypeLocations");
var ReactPropTypeLocationNames = require("./ReactPropTypeLocationNames");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");
var instantiateReactComponent = require("./instantiateReactComponent");
var invariant = require("./invariant");
var keyMirror = require("./keyMirror");
var keyOf = require("./keyOf");
var monitorCodeUse = require("./monitorCodeUse");
var mapObject = require("./mapObject");
var shouldUpdateReactComponent = require("./shouldUpdateReactComponent");
var warning = require("./warning");

var MIXINS_KEY = keyOf({mixins: null});

/**
 * Policies that describe methods in `ReactCompositeComponentInterface`.
 */
var SpecPolicy = keyMirror({
  /**
   * These methods may be defined only once by the class specification or mixin.
   */
  DEFINE_ONCE: null,
  /**
   * These methods may be defined by both the class specification and mixins.
   * Subsequent definitions will be chained. These methods must return void.
   */
  DEFINE_MANY: null,
  /**
   * These methods are overriding the base ReactCompositeComponent class.
   */
  OVERRIDE_BASE: null,
  /**
   * These methods are similar to DEFINE_MANY, except we assume they return
   * objects. We try to merge the keys of the return values of all the mixed in
   * functions. If there is a key conflict we throw.
   */
  DEFINE_MANY_MERGED: null
});


var injectedMixins = [];

/**
 * Composite components are higher-level components that compose other composite
 * or native components.
 *
 * To create a new type of `ReactCompositeComponent`, pass a specification of
 * your new class to `React.createClass`. The only requirement of your class
 * specification is that you implement a `render` method.
 *
 *   var MyComponent = React.createClass({
 *     render: function() {
 *       return <div>Hello World</div>;
 *     }
 *   });
 *
 * The class specification supports a specific protocol of methods that have
 * special meaning (e.g. `render`). See `ReactCompositeComponentInterface` for
 * more the comprehensive protocol. Any other properties and methods in the
 * class specification will available on the prototype.
 *
 * @interface ReactCompositeComponentInterface
 * @internal
 */
var ReactCompositeComponentInterface = {

  /**
   * An array of Mixin objects to include when defining your component.
   *
   * @type {array}
   * @optional
   */
  mixins: SpecPolicy.DEFINE_MANY,

  /**
   * An object containing properties and methods that should be defined on
   * the component's constructor instead of its prototype (static methods).
   *
   * @type {object}
   * @optional
   */
  statics: SpecPolicy.DEFINE_MANY,

  /**
   * Definition of prop types for this component.
   *
   * @type {object}
   * @optional
   */
  propTypes: SpecPolicy.DEFINE_MANY,

  /**
   * Definition of context types for this component.
   *
   * @type {object}
   * @optional
   */
  contextTypes: SpecPolicy.DEFINE_MANY,

  /**
   * Definition of context types this component sets for its children.
   *
   * @type {object}
   * @optional
   */
  childContextTypes: SpecPolicy.DEFINE_MANY,

  // ==== Definition methods ====

  /**
   * Invoked when the component is mounted. Values in the mapping will be set on
   * `this.props` if that prop is not specified (i.e. using an `in` check).
   *
   * This method is invoked before `getInitialState` and therefore cannot rely
   * on `this.state` or use `this.setState`.
   *
   * @return {object}
   * @optional
   */
  getDefaultProps: SpecPolicy.DEFINE_MANY_MERGED,

  /**
   * Invoked once before the component is mounted. The return value will be used
   * as the initial value of `this.state`.
   *
   *   getInitialState: function() {
   *     return {
   *       isOn: false,
   *       fooBaz: new BazFoo()
   *     }
   *   }
   *
   * @return {object}
   * @optional
   */
  getInitialState: SpecPolicy.DEFINE_MANY_MERGED,

  /**
   * @return {object}
   * @optional
   */
  getChildContext: SpecPolicy.DEFINE_MANY_MERGED,

  /**
   * Uses props from `this.props` and state from `this.state` to render the
   * structure of the component.
   *
   * No guarantees are made about when or how often this method is invoked, so
   * it must not have side effects.
   *
   *   render: function() {
   *     var name = this.props.name;
   *     return <div>Hello, {name}!</div>;
   *   }
   *
   * @return {ReactComponent}
   * @nosideeffects
   * @required
   */
  render: SpecPolicy.DEFINE_ONCE,



  // ==== Delegate methods ====

  /**
   * Invoked when the component is initially created and about to be mounted.
   * This may have side effects, but any external subscriptions or data created
   * by this method must be cleaned up in `componentWillUnmount`.
   *
   * @optional
   */
  componentWillMount: SpecPolicy.DEFINE_MANY,

  /**
   * Invoked when the component has been mounted and has a DOM representation.
   * However, there is no guarantee that the DOM node is in the document.
   *
   * Use this as an opportunity to operate on the DOM when the component has
   * been mounted (initialized and rendered) for the first time.
   *
   * @param {DOMElement} rootNode DOM element representing the component.
   * @optional
   */
  componentDidMount: SpecPolicy.DEFINE_MANY,

  /**
   * Invoked before the component receives new props.
   *
   * Use this as an opportunity to react to a prop transition by updating the
   * state using `this.setState`. Current props are accessed via `this.props`.
   *
   *   componentWillReceiveProps: function(nextProps, nextContext) {
   *     this.setState({
   *       likesIncreasing: nextProps.likeCount > this.props.likeCount
   *     });
   *   }
   *
   * NOTE: There is no equivalent `componentWillReceiveState`. An incoming prop
   * transition may cause a state change, but the opposite is not true. If you
   * need it, you are probably looking for `componentWillUpdate`.
   *
   * @param {object} nextProps
   * @optional
   */
  componentWillReceiveProps: SpecPolicy.DEFINE_MANY,

  /**
   * Invoked while deciding if the component should be updated as a result of
   * receiving new props, state and/or context.
   *
   * Use this as an opportunity to `return false` when you're certain that the
   * transition to the new props/state/context will not require a component
   * update.
   *
   *   shouldComponentUpdate: function(nextProps, nextState, nextContext) {
   *     return !equal(nextProps, this.props) ||
   *       !equal(nextState, this.state) ||
   *       !equal(nextContext, this.context);
   *   }
   *
   * @param {object} nextProps
   * @param {?object} nextState
   * @param {?object} nextContext
   * @return {boolean} True if the component should update.
   * @optional
   */
  shouldComponentUpdate: SpecPolicy.DEFINE_ONCE,

  /**
   * Invoked when the component is about to update due to a transition from
   * `this.props`, `this.state` and `this.context` to `nextProps`, `nextState`
   * and `nextContext`.
   *
   * Use this as an opportunity to perform preparation before an update occurs.
   *
   * NOTE: You **cannot** use `this.setState()` in this method.
   *
   * @param {object} nextProps
   * @param {?object} nextState
   * @param {?object} nextContext
   * @param {ReactReconcileTransaction} transaction
   * @optional
   */
  componentWillUpdate: SpecPolicy.DEFINE_MANY,

  /**
   * Invoked when the component's DOM representation has been updated.
   *
   * Use this as an opportunity to operate on the DOM when the component has
   * been updated.
   *
   * @param {object} prevProps
   * @param {?object} prevState
   * @param {?object} prevContext
   * @param {DOMElement} rootNode DOM element representing the component.
   * @optional
   */
  componentDidUpdate: SpecPolicy.DEFINE_MANY,

  /**
   * Invoked when the component is about to be removed from its parent and have
   * its DOM representation destroyed.
   *
   * Use this as an opportunity to deallocate any external resources.
   *
   * NOTE: There is no `componentDidUnmount` since your component will have been
   * destroyed by that point.
   *
   * @optional
   */
  componentWillUnmount: SpecPolicy.DEFINE_MANY,



  // ==== Advanced methods ====

  /**
   * Updates the component's currently mounted DOM representation.
   *
   * By default, this implements React's rendering and reconciliation algorithm.
   * Sophisticated clients may wish to override this.
   *
   * @param {ReactReconcileTransaction} transaction
   * @internal
   * @overridable
   */
  updateComponent: SpecPolicy.OVERRIDE_BASE

};

/**
 * Mapping from class specification keys to special processing functions.
 *
 * Although these are declared like instance properties in the specification
 * when defining classes using `React.createClass`, they are actually static
 * and are accessible on the constructor instead of the prototype. Despite
 * being static, they must be defined outside of the "statics" key under
 * which all other static methods are defined.
 */
var RESERVED_SPEC_KEYS = {
  displayName: function(Constructor, displayName) {
    Constructor.displayName = displayName;
  },
  mixins: function(Constructor, mixins) {
    if (mixins) {
      for (var i = 0; i < mixins.length; i++) {
        mixSpecIntoComponent(Constructor, mixins[i]);
      }
    }
  },
  childContextTypes: function(Constructor, childContextTypes) {
    validateTypeDef(
      Constructor,
      childContextTypes,
      ReactPropTypeLocations.childContext
    );
    Constructor.childContextTypes = assign(
      {},
      Constructor.childContextTypes,
      childContextTypes
    );
  },
  contextTypes: function(Constructor, contextTypes) {
    validateTypeDef(
      Constructor,
      contextTypes,
      ReactPropTypeLocations.context
    );
    Constructor.contextTypes = assign(
      {},
      Constructor.contextTypes,
      contextTypes
    );
  },
  /**
   * Special case getDefaultProps which should move into statics but requires
   * automatic merging.
   */
  getDefaultProps: function(Constructor, getDefaultProps) {
    if (Constructor.getDefaultProps) {
      Constructor.getDefaultProps = createMergedResultFunction(
        Constructor.getDefaultProps,
        getDefaultProps
      );
    } else {
      Constructor.getDefaultProps = getDefaultProps;
    }
  },
  propTypes: function(Constructor, propTypes) {
    validateTypeDef(
      Constructor,
      propTypes,
      ReactPropTypeLocations.prop
    );
    Constructor.propTypes = assign(
      {},
      Constructor.propTypes,
      propTypes
    );
  },
  statics: function(Constructor, statics) {
    mixStaticSpecIntoComponent(Constructor, statics);
  }
};

function getDeclarationErrorAddendum(component) {
  var owner = component._owner || null;
  if (owner && owner.constructor && owner.constructor.displayName) {
    return ' Check the render method of `' + owner.constructor.displayName +
      '`.';
  }
  return '';
}

function validateTypeDef(Constructor, typeDef, location) {
  for (var propName in typeDef) {
    if (typeDef.hasOwnProperty(propName)) {
      ("production" !== process.env.NODE_ENV ? invariant(
        typeof typeDef[propName] == 'function',
        '%s: %s type `%s` is invalid; it must be a function, usually from ' +
        'React.PropTypes.',
        Constructor.displayName || 'ReactCompositeComponent',
        ReactPropTypeLocationNames[location],
        propName
      ) : invariant(typeof typeDef[propName] == 'function'));
    }
  }
}

function validateMethodOverride(proto, name) {
  var specPolicy = ReactCompositeComponentInterface.hasOwnProperty(name) ?
    ReactCompositeComponentInterface[name] :
    null;

  // Disallow overriding of base class methods unless explicitly allowed.
  if (ReactCompositeComponentMixin.hasOwnProperty(name)) {
    ("production" !== process.env.NODE_ENV ? invariant(
      specPolicy === SpecPolicy.OVERRIDE_BASE,
      'ReactCompositeComponentInterface: You are attempting to override ' +
      '`%s` from your class specification. Ensure that your method names ' +
      'do not overlap with React methods.',
      name
    ) : invariant(specPolicy === SpecPolicy.OVERRIDE_BASE));
  }

  // Disallow defining methods more than once unless explicitly allowed.
  if (proto.hasOwnProperty(name)) {
    ("production" !== process.env.NODE_ENV ? invariant(
      specPolicy === SpecPolicy.DEFINE_MANY ||
      specPolicy === SpecPolicy.DEFINE_MANY_MERGED,
      'ReactCompositeComponentInterface: You are attempting to define ' +
      '`%s` on your component more than once. This conflict may be due ' +
      'to a mixin.',
      name
    ) : invariant(specPolicy === SpecPolicy.DEFINE_MANY ||
    specPolicy === SpecPolicy.DEFINE_MANY_MERGED));
  }
}

function validateLifeCycleOnReplaceState(instance) {
  var compositeLifeCycleState = instance._compositeLifeCycleState;
  ("production" !== process.env.NODE_ENV ? invariant(
    instance.isMounted() ||
      compositeLifeCycleState === CompositeLifeCycle.MOUNTING,
    'replaceState(...): Can only update a mounted or mounting component.'
  ) : invariant(instance.isMounted() ||
    compositeLifeCycleState === CompositeLifeCycle.MOUNTING));
  ("production" !== process.env.NODE_ENV ? invariant(
    ReactCurrentOwner.current == null,
    'replaceState(...): Cannot update during an existing state transition ' +
    '(such as within `render`). Render methods should be a pure function ' +
    'of props and state.'
  ) : invariant(ReactCurrentOwner.current == null));
  ("production" !== process.env.NODE_ENV ? invariant(compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING,
    'replaceState(...): Cannot update while unmounting component. This ' +
    'usually means you called setState() on an unmounted component.'
  ) : invariant(compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING));
}

/**
 * Mixin helper which handles policy validation and reserved
 * specification keys when building `ReactCompositeComponent` classses.
 */
function mixSpecIntoComponent(Constructor, spec) {
  if (!spec) {
    return;
  }

  ("production" !== process.env.NODE_ENV ? invariant(
    !ReactLegacyElement.isValidFactory(spec),
    'ReactCompositeComponent: You\'re attempting to ' +
    'use a component class as a mixin. Instead, just use a regular object.'
  ) : invariant(!ReactLegacyElement.isValidFactory(spec)));
  ("production" !== process.env.NODE_ENV ? invariant(
    !ReactElement.isValidElement(spec),
    'ReactCompositeComponent: You\'re attempting to ' +
    'use a component as a mixin. Instead, just use a regular object.'
  ) : invariant(!ReactElement.isValidElement(spec)));

  var proto = Constructor.prototype;

  // By handling mixins before any other properties, we ensure the same
  // chaining order is applied to methods with DEFINE_MANY policy, whether
  // mixins are listed before or after these methods in the spec.
  if (spec.hasOwnProperty(MIXINS_KEY)) {
    RESERVED_SPEC_KEYS.mixins(Constructor, spec.mixins);
  }

  for (var name in spec) {
    if (!spec.hasOwnProperty(name)) {
      continue;
    }

    if (name === MIXINS_KEY) {
      // We have already handled mixins in a special case above
      continue;
    }

    var property = spec[name];
    validateMethodOverride(proto, name);

    if (RESERVED_SPEC_KEYS.hasOwnProperty(name)) {
      RESERVED_SPEC_KEYS[name](Constructor, property);
    } else {
      // Setup methods on prototype:
      // The following member methods should not be automatically bound:
      // 1. Expected ReactCompositeComponent methods (in the "interface").
      // 2. Overridden methods (that were mixed in).
      var isCompositeComponentMethod =
        ReactCompositeComponentInterface.hasOwnProperty(name);
      var isAlreadyDefined = proto.hasOwnProperty(name);
      var markedDontBind = property && property.__reactDontBind;
      var isFunction = typeof property === 'function';
      var shouldAutoBind =
        isFunction &&
        !isCompositeComponentMethod &&
        !isAlreadyDefined &&
        !markedDontBind;

      if (shouldAutoBind) {
        if (!proto.__reactAutoBindMap) {
          proto.__reactAutoBindMap = {};
        }
        proto.__reactAutoBindMap[name] = property;
        proto[name] = property;
      } else {
        if (isAlreadyDefined) {
          var specPolicy = ReactCompositeComponentInterface[name];

          // These cases should already be caught by validateMethodOverride
          ("production" !== process.env.NODE_ENV ? invariant(
            isCompositeComponentMethod && (
              specPolicy === SpecPolicy.DEFINE_MANY_MERGED ||
              specPolicy === SpecPolicy.DEFINE_MANY
            ),
            'ReactCompositeComponent: Unexpected spec policy %s for key %s ' +
            'when mixing in component specs.',
            specPolicy,
            name
          ) : invariant(isCompositeComponentMethod && (
            specPolicy === SpecPolicy.DEFINE_MANY_MERGED ||
            specPolicy === SpecPolicy.DEFINE_MANY
          )));

          // For methods which are defined more than once, call the existing
          // methods before calling the new property, merging if appropriate.
          if (specPolicy === SpecPolicy.DEFINE_MANY_MERGED) {
            proto[name] = createMergedResultFunction(proto[name], property);
          } else if (specPolicy === SpecPolicy.DEFINE_MANY) {
            proto[name] = createChainedFunction(proto[name], property);
          }
        } else {
          proto[name] = property;
          if ("production" !== process.env.NODE_ENV) {
            // Add verbose displayName to the function, which helps when looking
            // at profiling tools.
            if (typeof property === 'function' && spec.displayName) {
              proto[name].displayName = spec.displayName + '_' + name;
            }
          }
        }
      }
    }
  }
}

function mixStaticSpecIntoComponent(Constructor, statics) {
  if (!statics) {
    return;
  }
  for (var name in statics) {
    var property = statics[name];
    if (!statics.hasOwnProperty(name)) {
      continue;
    }

    var isReserved = name in RESERVED_SPEC_KEYS;
    ("production" !== process.env.NODE_ENV ? invariant(
      !isReserved,
      'ReactCompositeComponent: You are attempting to define a reserved ' +
      'property, `%s`, that shouldn\'t be on the "statics" key. Define it ' +
      'as an instance property instead; it will still be accessible on the ' +
      'constructor.',
      name
    ) : invariant(!isReserved));

    var isInherited = name in Constructor;
    ("production" !== process.env.NODE_ENV ? invariant(
      !isInherited,
      'ReactCompositeComponent: You are attempting to define ' +
      '`%s` on your component more than once. This conflict may be ' +
      'due to a mixin.',
      name
    ) : invariant(!isInherited));
    Constructor[name] = property;
  }
}

/**
 * Merge two objects, but throw if both contain the same key.
 *
 * @param {object} one The first object, which is mutated.
 * @param {object} two The second object
 * @return {object} one after it has been mutated to contain everything in two.
 */
function mergeObjectsWithNoDuplicateKeys(one, two) {
  ("production" !== process.env.NODE_ENV ? invariant(
    one && two && typeof one === 'object' && typeof two === 'object',
    'mergeObjectsWithNoDuplicateKeys(): Cannot merge non-objects'
  ) : invariant(one && two && typeof one === 'object' && typeof two === 'object'));

  mapObject(two, function(value, key) {
    ("production" !== process.env.NODE_ENV ? invariant(
      one[key] === undefined,
      'mergeObjectsWithNoDuplicateKeys(): ' +
      'Tried to merge two objects with the same key: `%s`. This conflict ' +
      'may be due to a mixin; in particular, this may be caused by two ' +
      'getInitialState() or getDefaultProps() methods returning objects ' +
      'with clashing keys.',
      key
    ) : invariant(one[key] === undefined));
    one[key] = value;
  });
  return one;
}

/**
 * Creates a function that invokes two functions and merges their return values.
 *
 * @param {function} one Function to invoke first.
 * @param {function} two Function to invoke second.
 * @return {function} Function that invokes the two argument functions.
 * @private
 */
function createMergedResultFunction(one, two) {
  return function mergedResult() {
    var a = one.apply(this, arguments);
    var b = two.apply(this, arguments);
    if (a == null) {
      return b;
    } else if (b == null) {
      return a;
    }
    return mergeObjectsWithNoDuplicateKeys(a, b);
  };
}

/**
 * Creates a function that invokes two functions and ignores their return vales.
 *
 * @param {function} one Function to invoke first.
 * @param {function} two Function to invoke second.
 * @return {function} Function that invokes the two argument functions.
 * @private
 */
function createChainedFunction(one, two) {
  return function chainedFunction() {
    one.apply(this, arguments);
    two.apply(this, arguments);
  };
}

/**
 * `ReactCompositeComponent` maintains an auxiliary life cycle state in
 * `this._compositeLifeCycleState` (which can be null).
 *
 * This is different from the life cycle state maintained by `ReactComponent` in
 * `this._lifeCycleState`. The following diagram shows how the states overlap in
 * time. There are times when the CompositeLifeCycle is null - at those times it
 * is only meaningful to look at ComponentLifeCycle alone.
 *
 * Top Row: ReactComponent.ComponentLifeCycle
 * Low Row: ReactComponent.CompositeLifeCycle
 *
 * +-------+---------------------------------+--------+
 * |  UN   |             MOUNTED             |   UN   |
 * |MOUNTED|                                 | MOUNTED|
 * +-------+---------------------------------+--------+
 * |       ^--------+   +-------+   +--------^        |
 * |       |        |   |       |   |        |        |
 * |    0--|MOUNTING|-0-|RECEIVE|-0-|   UN   |--->0   |
 * |       |        |   |PROPS  |   |MOUNTING|        |
 * |       |        |   |       |   |        |        |
 * |       |        |   |       |   |        |        |
 * |       +--------+   +-------+   +--------+        |
 * |       |                                 |        |
 * +-------+---------------------------------+--------+
 */
var CompositeLifeCycle = keyMirror({
  /**
   * Components in the process of being mounted respond to state changes
   * differently.
   */
  MOUNTING: null,
  /**
   * Components in the process of being unmounted are guarded against state
   * changes.
   */
  UNMOUNTING: null,
  /**
   * Components that are mounted and receiving new props respond to state
   * changes differently.
   */
  RECEIVING_PROPS: null
});

/**
 * @lends {ReactCompositeComponent.prototype}
 */
var ReactCompositeComponentMixin = {

  /**
   * Base constructor for all composite component.
   *
   * @param {ReactElement} element
   * @final
   * @internal
   */
  construct: function(element) {
    // Children can be either an array or more than one argument
    ReactComponent.Mixin.construct.apply(this, arguments);
    ReactOwner.Mixin.construct.apply(this, arguments);

    this.state = null;
    this._pendingState = null;

    // This is the public post-processed context. The real context and pending
    // context lives on the element.
    this.context = null;

    this._compositeLifeCycleState = null;
  },

  /**
   * Checks whether or not this composite component is mounted.
   * @return {boolean} True if mounted, false otherwise.
   * @protected
   * @final
   */
  isMounted: function() {
    return ReactComponent.Mixin.isMounted.call(this) &&
      this._compositeLifeCycleState !== CompositeLifeCycle.MOUNTING;
  },

  /**
   * Initializes the component, renders markup, and registers event listeners.
   *
   * @param {string} rootID DOM ID of the root node.
   * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
   * @param {number} mountDepth number of components in the owner hierarchy
   * @return {?string} Rendered markup to be inserted into the DOM.
   * @final
   * @internal
   */
  mountComponent: ReactPerf.measure(
    'ReactCompositeComponent',
    'mountComponent',
    function(rootID, transaction, mountDepth) {
      ReactComponent.Mixin.mountComponent.call(
        this,
        rootID,
        transaction,
        mountDepth
      );
      this._compositeLifeCycleState = CompositeLifeCycle.MOUNTING;

      if (this.__reactAutoBindMap) {
        this._bindAutoBindMethods();
      }

      this.context = this._processContext(this._currentElement._context);
      this.props = this._processProps(this.props);

      this.state = this.getInitialState ? this.getInitialState() : null;
      ("production" !== process.env.NODE_ENV ? invariant(
        typeof this.state === 'object' && !Array.isArray(this.state),
        '%s.getInitialState(): must return an object or null',
        this.constructor.displayName || 'ReactCompositeComponent'
      ) : invariant(typeof this.state === 'object' && !Array.isArray(this.state)));

      this._pendingState = null;
      this._pendingForceUpdate = false;

      if (this.componentWillMount) {
        this.componentWillMount();
        // When mounting, calls to `setState` by `componentWillMount` will set
        // `this._pendingState` without triggering a re-render.
        if (this._pendingState) {
          this.state = this._pendingState;
          this._pendingState = null;
        }
      }

      this._renderedComponent = instantiateReactComponent(
        this._renderValidatedComponent(),
        this._currentElement.type // The wrapping type
      );

      // Done with mounting, `setState` will now trigger UI changes.
      this._compositeLifeCycleState = null;
      var markup = this._renderedComponent.mountComponent(
        rootID,
        transaction,
        mountDepth + 1
      );
      if (this.componentDidMount) {
        transaction.getReactMountReady().enqueue(this.componentDidMount, this);
      }
      return markup;
    }
  ),

  /**
   * Releases any resources allocated by `mountComponent`.
   *
   * @final
   * @internal
   */
  unmountComponent: function() {
    this._compositeLifeCycleState = CompositeLifeCycle.UNMOUNTING;
    if (this.componentWillUnmount) {
      this.componentWillUnmount();
    }
    this._compositeLifeCycleState = null;

    this._renderedComponent.unmountComponent();
    this._renderedComponent = null;

    ReactComponent.Mixin.unmountComponent.call(this);

    // Some existing components rely on this.props even after they've been
    // destroyed (in event handlers).
    // TODO: this.props = null;
    // TODO: this.state = null;
  },

  /**
   * Sets a subset of the state. Always use this or `replaceState` to mutate
   * state. You should treat `this.state` as immutable.
   *
   * There is no guarantee that `this.state` will be immediately updated, so
   * accessing `this.state` after calling this method may return the old value.
   *
   * There is no guarantee that calls to `setState` will run synchronously,
   * as they may eventually be batched together.  You can provide an optional
   * callback that will be executed when the call to setState is actually
   * completed.
   *
   * @param {object} partialState Next partial state to be merged with state.
   * @param {?function} callback Called after state is updated.
   * @final
   * @protected
   */
  setState: function(partialState, callback) {
    ("production" !== process.env.NODE_ENV ? invariant(
      typeof partialState === 'object' || partialState == null,
      'setState(...): takes an object of state variables to update.'
    ) : invariant(typeof partialState === 'object' || partialState == null));
    if ("production" !== process.env.NODE_ENV){
      ("production" !== process.env.NODE_ENV ? warning(
        partialState != null,
        'setState(...): You passed an undefined or null state object; ' +
        'instead, use forceUpdate().'
      ) : null);
    }
    // Merge with `_pendingState` if it exists, otherwise with existing state.
    this.replaceState(
      assign({}, this._pendingState || this.state, partialState),
      callback
    );
  },

  /**
   * Replaces all of the state. Always use this or `setState` to mutate state.
   * You should treat `this.state` as immutable.
   *
   * There is no guarantee that `this.state` will be immediately updated, so
   * accessing `this.state` after calling this method may return the old value.
   *
   * @param {object} completeState Next state.
   * @param {?function} callback Called after state is updated.
   * @final
   * @protected
   */
  replaceState: function(completeState, callback) {
    validateLifeCycleOnReplaceState(this);
    this._pendingState = completeState;
    if (this._compositeLifeCycleState !== CompositeLifeCycle.MOUNTING) {
      // If we're in a componentWillMount handler, don't enqueue a rerender
      // because ReactUpdates assumes we're in a browser context (which is wrong
      // for server rendering) and we're about to do a render anyway.
      // TODO: The callback here is ignored when setState is called from
      // componentWillMount. Either fix it or disallow doing so completely in
      // favor of getInitialState.
      ReactUpdates.enqueueUpdate(this, callback);
    }
  },

  /**
   * Filters the context object to only contain keys specified in
   * `contextTypes`, and asserts that they are valid.
   *
   * @param {object} context
   * @return {?object}
   * @private
   */
  _processContext: function(context) {
    var maskedContext = null;
    var contextTypes = this.constructor.contextTypes;
    if (contextTypes) {
      maskedContext = {};
      for (var contextName in contextTypes) {
        maskedContext[contextName] = context[contextName];
      }
      if ("production" !== process.env.NODE_ENV) {
        this._checkPropTypes(
          contextTypes,
          maskedContext,
          ReactPropTypeLocations.context
        );
      }
    }
    return maskedContext;
  },

  /**
   * @param {object} currentContext
   * @return {object}
   * @private
   */
  _processChildContext: function(currentContext) {
    var childContext = this.getChildContext && this.getChildContext();
    var displayName = this.constructor.displayName || 'ReactCompositeComponent';
    if (childContext) {
      ("production" !== process.env.NODE_ENV ? invariant(
        typeof this.constructor.childContextTypes === 'object',
        '%s.getChildContext(): childContextTypes must be defined in order to ' +
        'use getChildContext().',
        displayName
      ) : invariant(typeof this.constructor.childContextTypes === 'object'));
      if ("production" !== process.env.NODE_ENV) {
        this._checkPropTypes(
          this.constructor.childContextTypes,
          childContext,
          ReactPropTypeLocations.childContext
        );
      }
      for (var name in childContext) {
        ("production" !== process.env.NODE_ENV ? invariant(
          name in this.constructor.childContextTypes,
          '%s.getChildContext(): key "%s" is not defined in childContextTypes.',
          displayName,
          name
        ) : invariant(name in this.constructor.childContextTypes));
      }
      return assign({}, currentContext, childContext);
    }
    return currentContext;
  },

  /**
   * Processes props by setting default values for unspecified props and
   * asserting that the props are valid. Does not mutate its argument; returns
   * a new props object with defaults merged in.
   *
   * @param {object} newProps
   * @return {object}
   * @private
   */
  _processProps: function(newProps) {
    if ("production" !== process.env.NODE_ENV) {
      var propTypes = this.constructor.propTypes;
      if (propTypes) {
        this._checkPropTypes(propTypes, newProps, ReactPropTypeLocations.prop);
      }
    }
    return newProps;
  },

  /**
   * Assert that the props are valid
   *
   * @param {object} propTypes Map of prop name to a ReactPropType
   * @param {object} props
   * @param {string} location e.g. "prop", "context", "child context"
   * @private
   */
  _checkPropTypes: function(propTypes, props, location) {
    // TODO: Stop validating prop types here and only use the element
    // validation.
    var componentName = this.constructor.displayName;
    for (var propName in propTypes) {
      if (propTypes.hasOwnProperty(propName)) {
        var error =
          propTypes[propName](props, propName, componentName, location);
        if (error instanceof Error) {
          // We may want to extend this logic for similar errors in
          // renderComponent calls, so I'm abstracting it away into
          // a function to minimize refactoring in the future
          var addendum = getDeclarationErrorAddendum(this);
          ("production" !== process.env.NODE_ENV ? warning(false, error.message + addendum) : null);
        }
      }
    }
  },

  /**
   * If any of `_pendingElement`, `_pendingState`, or `_pendingForceUpdate`
   * is set, update the component.
   *
   * @param {ReactReconcileTransaction} transaction
   * @internal
   */
  performUpdateIfNecessary: function(transaction) {
    var compositeLifeCycleState = this._compositeLifeCycleState;
    // Do not trigger a state transition if we are in the middle of mounting or
    // receiving props because both of those will already be doing this.
    if (compositeLifeCycleState === CompositeLifeCycle.MOUNTING ||
        compositeLifeCycleState === CompositeLifeCycle.RECEIVING_PROPS) {
      return;
    }

    if (this._pendingElement == null &&
        this._pendingState == null &&
        !this._pendingForceUpdate) {
      return;
    }

    var nextContext = this.context;
    var nextProps = this.props;
    var nextElement = this._currentElement;
    if (this._pendingElement != null) {
      nextElement = this._pendingElement;
      nextContext = this._processContext(nextElement._context);
      nextProps = this._processProps(nextElement.props);
      this._pendingElement = null;

      this._compositeLifeCycleState = CompositeLifeCycle.RECEIVING_PROPS;
      if (this.componentWillReceiveProps) {
        this.componentWillReceiveProps(nextProps, nextContext);
      }
    }

    this._compositeLifeCycleState = null;

    var nextState = this._pendingState || this.state;
    this._pendingState = null;

    var shouldUpdate =
      this._pendingForceUpdate ||
      !this.shouldComponentUpdate ||
      this.shouldComponentUpdate(nextProps, nextState, nextContext);

    if ("production" !== process.env.NODE_ENV) {
      if (typeof shouldUpdate === "undefined") {
        console.warn(
          (this.constructor.displayName || 'ReactCompositeComponent') +
          '.shouldComponentUpdate(): Returned undefined instead of a ' +
          'boolean value. Make sure to return true or false.'
        );
      }
    }

    if (shouldUpdate) {
      this._pendingForceUpdate = false;
      // Will set `this.props`, `this.state` and `this.context`.
      this._performComponentUpdate(
        nextElement,
        nextProps,
        nextState,
        nextContext,
        transaction
      );
    } else {
      // If it's determined that a component should not update, we still want
      // to set props and state.
      this._currentElement = nextElement;
      this.props = nextProps;
      this.state = nextState;
      this.context = nextContext;

      // Owner cannot change because shouldUpdateReactComponent doesn't allow
      // it. TODO: Remove this._owner completely.
      this._owner = nextElement._owner;
    }
  },

  /**
   * Merges new props and state, notifies delegate methods of update and
   * performs update.
   *
   * @param {ReactElement} nextElement Next element
   * @param {object} nextProps Next public object to set as properties.
   * @param {?object} nextState Next object to set as state.
   * @param {?object} nextContext Next public object to set as context.
   * @param {ReactReconcileTransaction} transaction
   * @private
   */
  _performComponentUpdate: function(
    nextElement,
    nextProps,
    nextState,
    nextContext,
    transaction
  ) {
    var prevElement = this._currentElement;
    var prevProps = this.props;
    var prevState = this.state;
    var prevContext = this.context;

    if (this.componentWillUpdate) {
      this.componentWillUpdate(nextProps, nextState, nextContext);
    }

    this._currentElement = nextElement;
    this.props = nextProps;
    this.state = nextState;
    this.context = nextContext;

    // Owner cannot change because shouldUpdateReactComponent doesn't allow
    // it. TODO: Remove this._owner completely.
    this._owner = nextElement._owner;

    this.updateComponent(
      transaction,
      prevElement
    );

    if (this.componentDidUpdate) {
      transaction.getReactMountReady().enqueue(
        this.componentDidUpdate.bind(this, prevProps, prevState, prevContext),
        this
      );
    }
  },

  receiveComponent: function(nextElement, transaction) {
    if (nextElement === this._currentElement &&
        nextElement._owner != null) {
      // Since elements are immutable after the owner is rendered,
      // we can do a cheap identity compare here to determine if this is a
      // superfluous reconcile. It's possible for state to be mutable but such
      // change should trigger an update of the owner which would recreate
      // the element. We explicitly check for the existence of an owner since
      // it's possible for a element created outside a composite to be
      // deeply mutated and reused.
      return;
    }

    ReactComponent.Mixin.receiveComponent.call(
      this,
      nextElement,
      transaction
    );
  },

  /**
   * Updates the component's currently mounted DOM representation.
   *
   * By default, this implements React's rendering and reconciliation algorithm.
   * Sophisticated clients may wish to override this.
   *
   * @param {ReactReconcileTransaction} transaction
   * @param {ReactElement} prevElement
   * @internal
   * @overridable
   */
  updateComponent: ReactPerf.measure(
    'ReactCompositeComponent',
    'updateComponent',
    function(transaction, prevParentElement) {
      ReactComponent.Mixin.updateComponent.call(
        this,
        transaction,
        prevParentElement
      );

      var prevComponentInstance = this._renderedComponent;
      var prevElement = prevComponentInstance._currentElement;
      var nextElement = this._renderValidatedComponent();
      if (shouldUpdateReactComponent(prevElement, nextElement)) {
        prevComponentInstance.receiveComponent(nextElement, transaction);
      } else {
        // These two IDs are actually the same! But nothing should rely on that.
        var thisID = this._rootNodeID;
        var prevComponentID = prevComponentInstance._rootNodeID;
        prevComponentInstance.unmountComponent();
        this._renderedComponent = instantiateReactComponent(
          nextElement,
          this._currentElement.type
        );
        var nextMarkup = this._renderedComponent.mountComponent(
          thisID,
          transaction,
          this._mountDepth + 1
        );
        ReactComponent.BackendIDOperations.dangerouslyReplaceNodeWithMarkupByID(
          prevComponentID,
          nextMarkup
        );
      }
    }
  ),

  /**
   * Forces an update. This should only be invoked when it is known with
   * certainty that we are **not** in a DOM transaction.
   *
   * You may want to call this when you know that some deeper aspect of the
   * component's state has changed but `setState` was not called.
   *
   * This will not invoke `shouldUpdateComponent`, but it will invoke
   * `componentWillUpdate` and `componentDidUpdate`.
   *
   * @param {?function} callback Called after update is complete.
   * @final
   * @protected
   */
  forceUpdate: function(callback) {
    var compositeLifeCycleState = this._compositeLifeCycleState;
    ("production" !== process.env.NODE_ENV ? invariant(
      this.isMounted() ||
        compositeLifeCycleState === CompositeLifeCycle.MOUNTING,
      'forceUpdate(...): Can only force an update on mounted or mounting ' +
        'components.'
    ) : invariant(this.isMounted() ||
      compositeLifeCycleState === CompositeLifeCycle.MOUNTING));
    ("production" !== process.env.NODE_ENV ? invariant(
      compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING &&
      ReactCurrentOwner.current == null,
      'forceUpdate(...): Cannot force an update while unmounting component ' +
      'or within a `render` function.'
    ) : invariant(compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING &&
    ReactCurrentOwner.current == null));
    this._pendingForceUpdate = true;
    ReactUpdates.enqueueUpdate(this, callback);
  },

  /**
   * @private
   */
  _renderValidatedComponent: ReactPerf.measure(
    'ReactCompositeComponent',
    '_renderValidatedComponent',
    function() {
      var renderedComponent;
      var previousContext = ReactContext.current;
      ReactContext.current = this._processChildContext(
        this._currentElement._context
      );
      ReactCurrentOwner.current = this;
      try {
        renderedComponent = this.render();
        if (renderedComponent === null || renderedComponent === false) {
          renderedComponent = ReactEmptyComponent.getEmptyComponent();
          ReactEmptyComponent.registerNullComponentID(this._rootNodeID);
        } else {
          ReactEmptyComponent.deregisterNullComponentID(this._rootNodeID);
        }
      } finally {
        ReactContext.current = previousContext;
        ReactCurrentOwner.current = null;
      }
      ("production" !== process.env.NODE_ENV ? invariant(
        ReactElement.isValidElement(renderedComponent),
        '%s.render(): A valid ReactComponent must be returned. You may have ' +
          'returned undefined, an array or some other invalid object.',
        this.constructor.displayName || 'ReactCompositeComponent'
      ) : invariant(ReactElement.isValidElement(renderedComponent)));
      return renderedComponent;
    }
  ),

  /**
   * @private
   */
  _bindAutoBindMethods: function() {
    for (var autoBindKey in this.__reactAutoBindMap) {
      if (!this.__reactAutoBindMap.hasOwnProperty(autoBindKey)) {
        continue;
      }
      var method = this.__reactAutoBindMap[autoBindKey];
      this[autoBindKey] = this._bindAutoBindMethod(ReactErrorUtils.guard(
        method,
        this.constructor.displayName + '.' + autoBindKey
      ));
    }
  },

  /**
   * Binds a method to the component.
   *
   * @param {function} method Method to be bound.
   * @private
   */
  _bindAutoBindMethod: function(method) {
    var component = this;
    var boundMethod = method.bind(component);
    if ("production" !== process.env.NODE_ENV) {
      boundMethod.__reactBoundContext = component;
      boundMethod.__reactBoundMethod = method;
      boundMethod.__reactBoundArguments = null;
      var componentName = component.constructor.displayName;
      var _bind = boundMethod.bind;
      boundMethod.bind = function(newThis ) {for (var args=[],$__0=1,$__1=arguments.length;$__0<$__1;$__0++) args.push(arguments[$__0]);
        // User is trying to bind() an autobound method; we effectively will
        // ignore the value of "this" that the user is trying to use, so
        // let's warn.
        if (newThis !== component && newThis !== null) {
          monitorCodeUse('react_bind_warning', { component: componentName });
          console.warn(
            'bind(): React component methods may only be bound to the ' +
            'component instance. See ' + componentName
          );
        } else if (!args.length) {
          monitorCodeUse('react_bind_warning', { component: componentName });
          console.warn(
            'bind(): You are binding a component method to the component. ' +
            'React does this for you automatically in a high-performance ' +
            'way, so you can safely remove this call. See ' + componentName
          );
          return boundMethod;
        }
        var reboundMethod = _bind.apply(boundMethod, arguments);
        reboundMethod.__reactBoundContext = component;
        reboundMethod.__reactBoundMethod = method;
        reboundMethod.__reactBoundArguments = args;
        return reboundMethod;
      };
    }
    return boundMethod;
  }
};

var ReactCompositeComponentBase = function() {};
assign(
  ReactCompositeComponentBase.prototype,
  ReactComponent.Mixin,
  ReactOwner.Mixin,
  ReactPropTransferer.Mixin,
  ReactCompositeComponentMixin
);

/**
 * Module for creating composite components.
 *
 * @class ReactCompositeComponent
 * @extends ReactComponent
 * @extends ReactOwner
 * @extends ReactPropTransferer
 */
var ReactCompositeComponent = {

  LifeCycle: CompositeLifeCycle,

  Base: ReactCompositeComponentBase,

  /**
   * Creates a composite component class given a class specification.
   *
   * @param {object} spec Class specification (which must define `render`).
   * @return {function} Component constructor function.
   * @public
   */
  createClass: function(spec) {
    var Constructor = function(props) {
      // This constructor is overridden by mocks. The argument is used
      // by mocks to assert on what gets mounted. This will later be used
      // by the stand-alone class implementation.
    };
    Constructor.prototype = new ReactCompositeComponentBase();
    Constructor.prototype.constructor = Constructor;

    injectedMixins.forEach(
      mixSpecIntoComponent.bind(null, Constructor)
    );

    mixSpecIntoComponent(Constructor, spec);

    // Initialize the defaultProps property after all mixins have been merged
    if (Constructor.getDefaultProps) {
      Constructor.defaultProps = Constructor.getDefaultProps();
    }

    ("production" !== process.env.NODE_ENV ? invariant(
      Constructor.prototype.render,
      'createClass(...): Class specification must implement a `render` method.'
    ) : invariant(Constructor.prototype.render));

    if ("production" !== process.env.NODE_ENV) {
      if (Constructor.prototype.componentShouldUpdate) {
        monitorCodeUse(
          'react_component_should_update_warning',
          { component: spec.displayName }
        );
        console.warn(
          (spec.displayName || 'A component') + ' has a method called ' +
          'componentShouldUpdate(). Did you mean shouldComponentUpdate()? ' +
          'The name is phrased as a question because the function is ' +
          'expected to return a value.'
         );
      }
    }

    // Reduce time spent doing lookups by setting these on the prototype.
    for (var methodName in ReactCompositeComponentInterface) {
      if (!Constructor.prototype[methodName]) {
        Constructor.prototype[methodName] = null;
      }
    }

    if ("production" !== process.env.NODE_ENV) {
      return ReactLegacyElement.wrapFactory(
        ReactElementValidator.createFactory(Constructor)
      );
    }
    return ReactLegacyElement.wrapFactory(
      ReactElement.createFactory(Constructor)
    );
  },

  injection: {
    injectMixin: function(mixin) {
      injectedMixins.push(mixin);
    }
  }
};

module.exports = ReactCompositeComponent;

}).call(this,require('_process'))
},{"./Object.assign":26,"./ReactComponent":32,"./ReactContext":35,"./ReactCurrentOwner":36,"./ReactElement":52,"./ReactElementValidator":53,"./ReactEmptyComponent":54,"./ReactErrorUtils":55,"./ReactLegacyElement":61,"./ReactOwner":67,"./ReactPerf":68,"./ReactPropTransferer":69,"./ReactPropTypeLocationNames":70,"./ReactPropTypeLocations":71,"./ReactUpdates":79,"./instantiateReactComponent":125,"./invariant":126,"./keyMirror":132,"./keyOf":133,"./mapObject":134,"./monitorCodeUse":136,"./shouldUpdateReactComponent":142,"./warning":145,"_process":152}],35:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactContext
 */

"use strict";

var assign = require("./Object.assign");

/**
 * Keeps track of the current context.
 *
 * The context is automatically passed down the component ownership hierarchy
 * and is accessible via `this.context` on ReactCompositeComponents.
 */
var ReactContext = {

  /**
   * @internal
   * @type {object}
   */
  current: {},

  /**
   * Temporarily extends the current context while executing scopedCallback.
   *
   * A typical use case might look like
   *
   *  render: function() {
   *    var children = ReactContext.withContext({foo: 'foo'}, () => (
   *
   *    ));
   *    return <div>{children}</div>;
   *  }
   *
   * @param {object} newContext New context to merge into the existing context
   * @param {function} scopedCallback Callback to run with the new context
   * @return {ReactComponent|array<ReactComponent>}
   */
  withContext: function(newContext, scopedCallback) {
    var result;
    var previousContext = ReactContext.current;
    ReactContext.current = assign({}, previousContext, newContext);
    try {
      result = scopedCallback();
    } finally {
      ReactContext.current = previousContext;
    }
    return result;
  }

};

module.exports = ReactContext;

},{"./Object.assign":26}],36:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactCurrentOwner
 */

"use strict";

/**
 * Keeps track of the current owner.
 *
 * The current owner is the component who should own any components that are
 * currently being constructed.
 *
 * The depth indicate how many composite components are above this render level.
 */
var ReactCurrentOwner = {

  /**
   * @internal
   * @type {ReactComponent}
   */
  current: null

};

module.exports = ReactCurrentOwner;

},{}],37:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOM
 * @typechecks static-only
 */

"use strict";

var ReactElement = require("./ReactElement");
var ReactElementValidator = require("./ReactElementValidator");
var ReactLegacyElement = require("./ReactLegacyElement");

var mapObject = require("./mapObject");

/**
 * Create a factory that creates HTML tag elements.
 *
 * @param {string} tag Tag name (e.g. `div`).
 * @private
 */
function createDOMFactory(tag) {
  if ("production" !== process.env.NODE_ENV) {
    return ReactLegacyElement.markNonLegacyFactory(
      ReactElementValidator.createFactory(tag)
    );
  }
  return ReactLegacyElement.markNonLegacyFactory(
    ReactElement.createFactory(tag)
  );
}

/**
 * Creates a mapping from supported HTML tags to `ReactDOMComponent` classes.
 * This is also accessible via `React.DOM`.
 *
 * @public
 */
var ReactDOM = mapObject({
  a: 'a',
  abbr: 'abbr',
  address: 'address',
  area: 'area',
  article: 'article',
  aside: 'aside',
  audio: 'audio',
  b: 'b',
  base: 'base',
  bdi: 'bdi',
  bdo: 'bdo',
  big: 'big',
  blockquote: 'blockquote',
  body: 'body',
  br: 'br',
  button: 'button',
  canvas: 'canvas',
  caption: 'caption',
  cite: 'cite',
  code: 'code',
  col: 'col',
  colgroup: 'colgroup',
  data: 'data',
  datalist: 'datalist',
  dd: 'dd',
  del: 'del',
  details: 'details',
  dfn: 'dfn',
  dialog: 'dialog',
  div: 'div',
  dl: 'dl',
  dt: 'dt',
  em: 'em',
  embed: 'embed',
  fieldset: 'fieldset',
  figcaption: 'figcaption',
  figure: 'figure',
  footer: 'footer',
  form: 'form',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  head: 'head',
  header: 'header',
  hr: 'hr',
  html: 'html',
  i: 'i',
  iframe: 'iframe',
  img: 'img',
  input: 'input',
  ins: 'ins',
  kbd: 'kbd',
  keygen: 'keygen',
  label: 'label',
  legend: 'legend',
  li: 'li',
  link: 'link',
  main: 'main',
  map: 'map',
  mark: 'mark',
  menu: 'menu',
  menuitem: 'menuitem',
  meta: 'meta',
  meter: 'meter',
  nav: 'nav',
  noscript: 'noscript',
  object: 'object',
  ol: 'ol',
  optgroup: 'optgroup',
  option: 'option',
  output: 'output',
  p: 'p',
  param: 'param',
  picture: 'picture',
  pre: 'pre',
  progress: 'progress',
  q: 'q',
  rp: 'rp',
  rt: 'rt',
  ruby: 'ruby',
  s: 's',
  samp: 'samp',
  script: 'script',
  section: 'section',
  select: 'select',
  small: 'small',
  source: 'source',
  span: 'span',
  strong: 'strong',
  style: 'style',
  sub: 'sub',
  summary: 'summary',
  sup: 'sup',
  table: 'table',
  tbody: 'tbody',
  td: 'td',
  textarea: 'textarea',
  tfoot: 'tfoot',
  th: 'th',
  thead: 'thead',
  time: 'time',
  title: 'title',
  tr: 'tr',
  track: 'track',
  u: 'u',
  ul: 'ul',
  'var': 'var',
  video: 'video',
  wbr: 'wbr',

  // SVG
  circle: 'circle',
  defs: 'defs',
  ellipse: 'ellipse',
  g: 'g',
  line: 'line',
  linearGradient: 'linearGradient',
  mask: 'mask',
  path: 'path',
  pattern: 'pattern',
  polygon: 'polygon',
  polyline: 'polyline',
  radialGradient: 'radialGradient',
  rect: 'rect',
  stop: 'stop',
  svg: 'svg',
  text: 'text',
  tspan: 'tspan'

}, createDOMFactory);

module.exports = ReactDOM;

}).call(this,require('_process'))
},{"./ReactElement":52,"./ReactElementValidator":53,"./ReactLegacyElement":61,"./mapObject":134,"_process":152}],38:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMButton
 */

"use strict";

var AutoFocusMixin = require("./AutoFocusMixin");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");

var keyMirror = require("./keyMirror");

// Store a reference to the <button> `ReactDOMComponent`. TODO: use string
var button = ReactElement.createFactory(ReactDOM.button.type);

var mouseListenerNames = keyMirror({
  onClick: true,
  onDoubleClick: true,
  onMouseDown: true,
  onMouseMove: true,
  onMouseUp: true,
  onClickCapture: true,
  onDoubleClickCapture: true,
  onMouseDownCapture: true,
  onMouseMoveCapture: true,
  onMouseUpCapture: true
});

/**
 * Implements a <button> native component that does not receive mouse events
 * when `disabled` is set.
 */
var ReactDOMButton = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMButton',

  mixins: [AutoFocusMixin, ReactBrowserComponentMixin],

  render: function() {
    var props = {};

    // Copy the props; except the mouse listeners if we're disabled
    for (var key in this.props) {
      if (this.props.hasOwnProperty(key) &&
          (!this.props.disabled || !mouseListenerNames[key])) {
        props[key] = this.props[key];
      }
    }

    return button(props, this.props.children);
  }

});

module.exports = ReactDOMButton;

},{"./AutoFocusMixin":1,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52,"./keyMirror":132}],39:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMComponent
 * @typechecks static-only
 */

"use strict";

var CSSPropertyOperations = require("./CSSPropertyOperations");
var DOMProperty = require("./DOMProperty");
var DOMPropertyOperations = require("./DOMPropertyOperations");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactComponent = require("./ReactComponent");
var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");
var ReactMount = require("./ReactMount");
var ReactMultiChild = require("./ReactMultiChild");
var ReactPerf = require("./ReactPerf");

var assign = require("./Object.assign");
var escapeTextForBrowser = require("./escapeTextForBrowser");
var invariant = require("./invariant");
var isEventSupported = require("./isEventSupported");
var keyOf = require("./keyOf");
var monitorCodeUse = require("./monitorCodeUse");

var deleteListener = ReactBrowserEventEmitter.deleteListener;
var listenTo = ReactBrowserEventEmitter.listenTo;
var registrationNameModules = ReactBrowserEventEmitter.registrationNameModules;

// For quickly matching children type, to test if can be treated as content.
var CONTENT_TYPES = {'string': true, 'number': true};

var STYLE = keyOf({style: null});

var ELEMENT_NODE_TYPE = 1;

/**
 * @param {?object} props
 */
function assertValidProps(props) {
  if (!props) {
    return;
  }
  // Note the use of `==` which checks for null or undefined.
  ("production" !== process.env.NODE_ENV ? invariant(
    props.children == null || props.dangerouslySetInnerHTML == null,
    'Can only set one of `children` or `props.dangerouslySetInnerHTML`.'
  ) : invariant(props.children == null || props.dangerouslySetInnerHTML == null));
  if ("production" !== process.env.NODE_ENV) {
    if (props.contentEditable && props.children != null) {
      console.warn(
        'A component is `contentEditable` and contains `children` managed by ' +
        'React. It is now your responsibility to guarantee that none of those '+
        'nodes are unexpectedly modified or duplicated. This is probably not ' +
        'intentional.'
      );
    }
  }
  ("production" !== process.env.NODE_ENV ? invariant(
    props.style == null || typeof props.style === 'object',
    'The `style` prop expects a mapping from style properties to values, ' +
    'not a string.'
  ) : invariant(props.style == null || typeof props.style === 'object'));
}

function putListener(id, registrationName, listener, transaction) {
  if ("production" !== process.env.NODE_ENV) {
    // IE8 has no API for event capturing and the `onScroll` event doesn't
    // bubble.
    if (registrationName === 'onScroll' &&
        !isEventSupported('scroll', true)) {
      monitorCodeUse('react_no_scroll_event');
      console.warn('This browser doesn\'t support the `onScroll` event');
    }
  }
  var container = ReactMount.findReactContainerForID(id);
  if (container) {
    var doc = container.nodeType === ELEMENT_NODE_TYPE ?
      container.ownerDocument :
      container;
    listenTo(registrationName, doc);
  }
  transaction.getPutListenerQueue().enqueuePutListener(
    id,
    registrationName,
    listener
  );
}

// For HTML, certain tags should omit their close tag. We keep a whitelist for
// those special cased tags.

var omittedCloseTags = {
  'area': true,
  'base': true,
  'br': true,
  'col': true,
  'embed': true,
  'hr': true,
  'img': true,
  'input': true,
  'keygen': true,
  'link': true,
  'meta': true,
  'param': true,
  'source': true,
  'track': true,
  'wbr': true
  // NOTE: menuitem's close tag should be omitted, but that causes problems.
};

// We accept any tag to be rendered but since this gets injected into abitrary
// HTML, we want to make sure that it's a safe tag.
// http://www.w3.org/TR/REC-xml/#NT-Name

var VALID_TAG_REGEX = /^[a-zA-Z][a-zA-Z:_\.\-\d]*$/; // Simplified subset
var validatedTagCache = {};
var hasOwnProperty = {}.hasOwnProperty;

function validateDangerousTag(tag) {
  if (!hasOwnProperty.call(validatedTagCache, tag)) {
    ("production" !== process.env.NODE_ENV ? invariant(VALID_TAG_REGEX.test(tag), 'Invalid tag: %s', tag) : invariant(VALID_TAG_REGEX.test(tag)));
    validatedTagCache[tag] = true;
  }
}

/**
 * Creates a new React class that is idempotent and capable of containing other
 * React components. It accepts event listeners and DOM properties that are
 * valid according to `DOMProperty`.
 *
 *  - Event listeners: `onClick`, `onMouseDown`, etc.
 *  - DOM properties: `className`, `name`, `title`, etc.
 *
 * The `style` property functions differently from the DOM API. It accepts an
 * object mapping of style properties to values.
 *
 * @constructor ReactDOMComponent
 * @extends ReactComponent
 * @extends ReactMultiChild
 */
function ReactDOMComponent(tag) {
  validateDangerousTag(tag);
  this._tag = tag;
  this.tagName = tag.toUpperCase();
}

ReactDOMComponent.displayName = 'ReactDOMComponent';

ReactDOMComponent.Mixin = {

  /**
   * Generates root tag markup then recurses. This method has side effects and
   * is not idempotent.
   *
   * @internal
   * @param {string} rootID The root DOM ID for this node.
   * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
   * @param {number} mountDepth number of components in the owner hierarchy
   * @return {string} The computed markup.
   */
  mountComponent: ReactPerf.measure(
    'ReactDOMComponent',
    'mountComponent',
    function(rootID, transaction, mountDepth) {
      ReactComponent.Mixin.mountComponent.call(
        this,
        rootID,
        transaction,
        mountDepth
      );
      assertValidProps(this.props);
      var closeTag = omittedCloseTags[this._tag] ? '' : '</' + this._tag + '>';
      return (
        this._createOpenTagMarkupAndPutListeners(transaction) +
        this._createContentMarkup(transaction) +
        closeTag
      );
    }
  ),

  /**
   * Creates markup for the open tag and all attributes.
   *
   * This method has side effects because events get registered.
   *
   * Iterating over object properties is faster than iterating over arrays.
   * @see http://jsperf.com/obj-vs-arr-iteration
   *
   * @private
   * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
   * @return {string} Markup of opening tag.
   */
  _createOpenTagMarkupAndPutListeners: function(transaction) {
    var props = this.props;
    var ret = '<' + this._tag;

    for (var propKey in props) {
      if (!props.hasOwnProperty(propKey)) {
        continue;
      }
      var propValue = props[propKey];
      if (propValue == null) {
        continue;
      }
      if (registrationNameModules.hasOwnProperty(propKey)) {
        putListener(this._rootNodeID, propKey, propValue, transaction);
      } else {
        if (propKey === STYLE) {
          if (propValue) {
            propValue = props.style = assign({}, props.style);
          }
          propValue = CSSPropertyOperations.createMarkupForStyles(propValue);
        }
        var markup =
          DOMPropertyOperations.createMarkupForProperty(propKey, propValue);
        if (markup) {
          ret += ' ' + markup;
        }
      }
    }

    // For static pages, no need to put React ID and checksum. Saves lots of
    // bytes.
    if (transaction.renderToStaticMarkup) {
      return ret + '>';
    }

    var markupForID = DOMPropertyOperations.createMarkupForID(this._rootNodeID);
    return ret + ' ' + markupForID + '>';
  },

  /**
   * Creates markup for the content between the tags.
   *
   * @private
   * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
   * @return {string} Content markup.
   */
  _createContentMarkup: function(transaction) {
    // Intentional use of != to avoid catching zero/false.
    var innerHTML = this.props.dangerouslySetInnerHTML;
    if (innerHTML != null) {
      if (innerHTML.__html != null) {
        return innerHTML.__html;
      }
    } else {
      var contentToUse =
        CONTENT_TYPES[typeof this.props.children] ? this.props.children : null;
      var childrenToUse = contentToUse != null ? null : this.props.children;
      if (contentToUse != null) {
        return escapeTextForBrowser(contentToUse);
      } else if (childrenToUse != null) {
        var mountImages = this.mountChildren(
          childrenToUse,
          transaction
        );
        return mountImages.join('');
      }
    }
    return '';
  },

  receiveComponent: function(nextElement, transaction) {
    if (nextElement === this._currentElement &&
        nextElement._owner != null) {
      // Since elements are immutable after the owner is rendered,
      // we can do a cheap identity compare here to determine if this is a
      // superfluous reconcile. It's possible for state to be mutable but such
      // change should trigger an update of the owner which would recreate
      // the element. We explicitly check for the existence of an owner since
      // it's possible for a element created outside a composite to be
      // deeply mutated and reused.
      return;
    }

    ReactComponent.Mixin.receiveComponent.call(
      this,
      nextElement,
      transaction
    );
  },

  /**
   * Updates a native DOM component after it has already been allocated and
   * attached to the DOM. Reconciles the root DOM node, then recurses.
   *
   * @param {ReactReconcileTransaction} transaction
   * @param {ReactElement} prevElement
   * @internal
   * @overridable
   */
  updateComponent: ReactPerf.measure(
    'ReactDOMComponent',
    'updateComponent',
    function(transaction, prevElement) {
      assertValidProps(this._currentElement.props);
      ReactComponent.Mixin.updateComponent.call(
        this,
        transaction,
        prevElement
      );
      this._updateDOMProperties(prevElement.props, transaction);
      this._updateDOMChildren(prevElement.props, transaction);
    }
  ),

  /**
   * Reconciles the properties by detecting differences in property values and
   * updating the DOM as necessary. This function is probably the single most
   * critical path for performance optimization.
   *
   * TODO: Benchmark whether checking for changed values in memory actually
   *       improves performance (especially statically positioned elements).
   * TODO: Benchmark the effects of putting this at the top since 99% of props
   *       do not change for a given reconciliation.
   * TODO: Benchmark areas that can be improved with caching.
   *
   * @private
   * @param {object} lastProps
   * @param {ReactReconcileTransaction} transaction
   */
  _updateDOMProperties: function(lastProps, transaction) {
    var nextProps = this.props;
    var propKey;
    var styleName;
    var styleUpdates;
    for (propKey in lastProps) {
      if (nextProps.hasOwnProperty(propKey) ||
         !lastProps.hasOwnProperty(propKey)) {
        continue;
      }
      if (propKey === STYLE) {
        var lastStyle = lastProps[propKey];
        for (styleName in lastStyle) {
          if (lastStyle.hasOwnProperty(styleName)) {
            styleUpdates = styleUpdates || {};
            styleUpdates[styleName] = '';
          }
        }
      } else if (registrationNameModules.hasOwnProperty(propKey)) {
        deleteListener(this._rootNodeID, propKey);
      } else if (
          DOMProperty.isStandardName[propKey] ||
          DOMProperty.isCustomAttribute(propKey)) {
        ReactComponent.BackendIDOperations.deletePropertyByID(
          this._rootNodeID,
          propKey
        );
      }
    }
    for (propKey in nextProps) {
      var nextProp = nextProps[propKey];
      var lastProp = lastProps[propKey];
      if (!nextProps.hasOwnProperty(propKey) || nextProp === lastProp) {
        continue;
      }
      if (propKey === STYLE) {
        if (nextProp) {
          nextProp = nextProps.style = assign({}, nextProp);
        }
        if (lastProp) {
          // Unset styles on `lastProp` but not on `nextProp`.
          for (styleName in lastProp) {
            if (lastProp.hasOwnProperty(styleName) &&
                (!nextProp || !nextProp.hasOwnProperty(styleName))) {
              styleUpdates = styleUpdates || {};
              styleUpdates[styleName] = '';
            }
          }
          // Update styles that changed since `lastProp`.
          for (styleName in nextProp) {
            if (nextProp.hasOwnProperty(styleName) &&
                lastProp[styleName] !== nextProp[styleName]) {
              styleUpdates = styleUpdates || {};
              styleUpdates[styleName] = nextProp[styleName];
            }
          }
        } else {
          // Relies on `updateStylesByID` not mutating `styleUpdates`.
          styleUpdates = nextProp;
        }
      } else if (registrationNameModules.hasOwnProperty(propKey)) {
        putListener(this._rootNodeID, propKey, nextProp, transaction);
      } else if (
          DOMProperty.isStandardName[propKey] ||
          DOMProperty.isCustomAttribute(propKey)) {
        ReactComponent.BackendIDOperations.updatePropertyByID(
          this._rootNodeID,
          propKey,
          nextProp
        );
      }
    }
    if (styleUpdates) {
      ReactComponent.BackendIDOperations.updateStylesByID(
        this._rootNodeID,
        styleUpdates
      );
    }
  },

  /**
   * Reconciles the children with the various properties that affect the
   * children content.
   *
   * @param {object} lastProps
   * @param {ReactReconcileTransaction} transaction
   */
  _updateDOMChildren: function(lastProps, transaction) {
    var nextProps = this.props;

    var lastContent =
      CONTENT_TYPES[typeof lastProps.children] ? lastProps.children : null;
    var nextContent =
      CONTENT_TYPES[typeof nextProps.children] ? nextProps.children : null;

    var lastHtml =
      lastProps.dangerouslySetInnerHTML &&
      lastProps.dangerouslySetInnerHTML.__html;
    var nextHtml =
      nextProps.dangerouslySetInnerHTML &&
      nextProps.dangerouslySetInnerHTML.__html;

    // Note the use of `!=` which checks for null or undefined.
    var lastChildren = lastContent != null ? null : lastProps.children;
    var nextChildren = nextContent != null ? null : nextProps.children;

    // If we're switching from children to content/html or vice versa, remove
    // the old content
    var lastHasContentOrHtml = lastContent != null || lastHtml != null;
    var nextHasContentOrHtml = nextContent != null || nextHtml != null;
    if (lastChildren != null && nextChildren == null) {
      this.updateChildren(null, transaction);
    } else if (lastHasContentOrHtml && !nextHasContentOrHtml) {
      this.updateTextContent('');
    }

    if (nextContent != null) {
      if (lastContent !== nextContent) {
        this.updateTextContent('' + nextContent);
      }
    } else if (nextHtml != null) {
      if (lastHtml !== nextHtml) {
        ReactComponent.BackendIDOperations.updateInnerHTMLByID(
          this._rootNodeID,
          nextHtml
        );
      }
    } else if (nextChildren != null) {
      this.updateChildren(nextChildren, transaction);
    }
  },

  /**
   * Destroys all event registrations for this instance. Does not remove from
   * the DOM. That must be done by the parent.
   *
   * @internal
   */
  unmountComponent: function() {
    this.unmountChildren();
    ReactBrowserEventEmitter.deleteAllListeners(this._rootNodeID);
    ReactComponent.Mixin.unmountComponent.call(this);
  }

};

assign(
  ReactDOMComponent.prototype,
  ReactComponent.Mixin,
  ReactDOMComponent.Mixin,
  ReactMultiChild.Mixin,
  ReactBrowserComponentMixin
);

module.exports = ReactDOMComponent;

}).call(this,require('_process'))
},{"./CSSPropertyOperations":4,"./DOMProperty":10,"./DOMPropertyOperations":11,"./Object.assign":26,"./ReactBrowserComponentMixin":29,"./ReactBrowserEventEmitter":30,"./ReactComponent":32,"./ReactMount":63,"./ReactMultiChild":64,"./ReactPerf":68,"./escapeTextForBrowser":109,"./invariant":126,"./isEventSupported":127,"./keyOf":133,"./monitorCodeUse":136,"_process":152}],40:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMForm
 */

"use strict";

var EventConstants = require("./EventConstants");
var LocalEventTrapMixin = require("./LocalEventTrapMixin");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");

// Store a reference to the <form> `ReactDOMComponent`. TODO: use string
var form = ReactElement.createFactory(ReactDOM.form.type);

/**
 * Since onSubmit doesn't bubble OR capture on the top level in IE8, we need
 * to capture it on the <form> element itself. There are lots of hacks we could
 * do to accomplish this, but the most reliable is to make <form> a
 * composite component and use `componentDidMount` to attach the event handlers.
 */
var ReactDOMForm = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMForm',

  mixins: [ReactBrowserComponentMixin, LocalEventTrapMixin],

  render: function() {
    // TODO: Instead of using `ReactDOM` directly, we should use JSX. However,
    // `jshint` fails to parse JSX so in order for linting to work in the open
    // source repo, we need to just use `ReactDOM.form`.
    return form(this.props);
  },

  componentDidMount: function() {
    this.trapBubbledEvent(EventConstants.topLevelTypes.topReset, 'reset');
    this.trapBubbledEvent(EventConstants.topLevelTypes.topSubmit, 'submit');
  }
});

module.exports = ReactDOMForm;

},{"./EventConstants":15,"./LocalEventTrapMixin":24,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52}],41:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMIDOperations
 * @typechecks static-only
 */

/*jslint evil: true */

"use strict";

var CSSPropertyOperations = require("./CSSPropertyOperations");
var DOMChildrenOperations = require("./DOMChildrenOperations");
var DOMPropertyOperations = require("./DOMPropertyOperations");
var ReactMount = require("./ReactMount");
var ReactPerf = require("./ReactPerf");

var invariant = require("./invariant");
var setInnerHTML = require("./setInnerHTML");

/**
 * Errors for properties that should not be updated with `updatePropertyById()`.
 *
 * @type {object}
 * @private
 */
var INVALID_PROPERTY_ERRORS = {
  dangerouslySetInnerHTML:
    '`dangerouslySetInnerHTML` must be set using `updateInnerHTMLByID()`.',
  style: '`style` must be set using `updateStylesByID()`.'
};

/**
 * Operations used to process updates to DOM nodes. This is made injectable via
 * `ReactComponent.BackendIDOperations`.
 */
var ReactDOMIDOperations = {

  /**
   * Updates a DOM node with new property values. This should only be used to
   * update DOM properties in `DOMProperty`.
   *
   * @param {string} id ID of the node to update.
   * @param {string} name A valid property name, see `DOMProperty`.
   * @param {*} value New value of the property.
   * @internal
   */
  updatePropertyByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'updatePropertyByID',
    function(id, name, value) {
      var node = ReactMount.getNode(id);
      ("production" !== process.env.NODE_ENV ? invariant(
        !INVALID_PROPERTY_ERRORS.hasOwnProperty(name),
        'updatePropertyByID(...): %s',
        INVALID_PROPERTY_ERRORS[name]
      ) : invariant(!INVALID_PROPERTY_ERRORS.hasOwnProperty(name)));

      // If we're updating to null or undefined, we should remove the property
      // from the DOM node instead of inadvertantly setting to a string. This
      // brings us in line with the same behavior we have on initial render.
      if (value != null) {
        DOMPropertyOperations.setValueForProperty(node, name, value);
      } else {
        DOMPropertyOperations.deleteValueForProperty(node, name);
      }
    }
  ),

  /**
   * Updates a DOM node to remove a property. This should only be used to remove
   * DOM properties in `DOMProperty`.
   *
   * @param {string} id ID of the node to update.
   * @param {string} name A property name to remove, see `DOMProperty`.
   * @internal
   */
  deletePropertyByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'deletePropertyByID',
    function(id, name, value) {
      var node = ReactMount.getNode(id);
      ("production" !== process.env.NODE_ENV ? invariant(
        !INVALID_PROPERTY_ERRORS.hasOwnProperty(name),
        'updatePropertyByID(...): %s',
        INVALID_PROPERTY_ERRORS[name]
      ) : invariant(!INVALID_PROPERTY_ERRORS.hasOwnProperty(name)));
      DOMPropertyOperations.deleteValueForProperty(node, name, value);
    }
  ),

  /**
   * Updates a DOM node with new style values. If a value is specified as '',
   * the corresponding style property will be unset.
   *
   * @param {string} id ID of the node to update.
   * @param {object} styles Mapping from styles to values.
   * @internal
   */
  updateStylesByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'updateStylesByID',
    function(id, styles) {
      var node = ReactMount.getNode(id);
      CSSPropertyOperations.setValueForStyles(node, styles);
    }
  ),

  /**
   * Updates a DOM node's innerHTML.
   *
   * @param {string} id ID of the node to update.
   * @param {string} html An HTML string.
   * @internal
   */
  updateInnerHTMLByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'updateInnerHTMLByID',
    function(id, html) {
      var node = ReactMount.getNode(id);
      setInnerHTML(node, html);
    }
  ),

  /**
   * Updates a DOM node's text content set by `props.content`.
   *
   * @param {string} id ID of the node to update.
   * @param {string} content Text content.
   * @internal
   */
  updateTextContentByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'updateTextContentByID',
    function(id, content) {
      var node = ReactMount.getNode(id);
      DOMChildrenOperations.updateTextContent(node, content);
    }
  ),

  /**
   * Replaces a DOM node that exists in the document with markup.
   *
   * @param {string} id ID of child to be replaced.
   * @param {string} markup Dangerous markup to inject in place of child.
   * @internal
   * @see {Danger.dangerouslyReplaceNodeWithMarkup}
   */
  dangerouslyReplaceNodeWithMarkupByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'dangerouslyReplaceNodeWithMarkupByID',
    function(id, markup) {
      var node = ReactMount.getNode(id);
      DOMChildrenOperations.dangerouslyReplaceNodeWithMarkup(node, markup);
    }
  ),

  /**
   * Updates a component's children by processing a series of updates.
   *
   * @param {array<object>} updates List of update configurations.
   * @param {array<string>} markup List of markup strings.
   * @internal
   */
  dangerouslyProcessChildrenUpdates: ReactPerf.measure(
    'ReactDOMIDOperations',
    'dangerouslyProcessChildrenUpdates',
    function(updates, markup) {
      for (var i = 0; i < updates.length; i++) {
        updates[i].parentNode = ReactMount.getNode(updates[i].parentID);
      }
      DOMChildrenOperations.processUpdates(updates, markup);
    }
  )
};

module.exports = ReactDOMIDOperations;

}).call(this,require('_process'))
},{"./CSSPropertyOperations":4,"./DOMChildrenOperations":9,"./DOMPropertyOperations":11,"./ReactMount":63,"./ReactPerf":68,"./invariant":126,"./setInnerHTML":140,"_process":152}],42:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMImg
 */

"use strict";

var EventConstants = require("./EventConstants");
var LocalEventTrapMixin = require("./LocalEventTrapMixin");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");

// Store a reference to the <img> `ReactDOMComponent`. TODO: use string
var img = ReactElement.createFactory(ReactDOM.img.type);

/**
 * Since onLoad doesn't bubble OR capture on the top level in IE8, we need to
 * capture it on the <img> element itself. There are lots of hacks we could do
 * to accomplish this, but the most reliable is to make <img> a composite
 * component and use `componentDidMount` to attach the event handlers.
 */
var ReactDOMImg = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMImg',
  tagName: 'IMG',

  mixins: [ReactBrowserComponentMixin, LocalEventTrapMixin],

  render: function() {
    return img(this.props);
  },

  componentDidMount: function() {
    this.trapBubbledEvent(EventConstants.topLevelTypes.topLoad, 'load');
    this.trapBubbledEvent(EventConstants.topLevelTypes.topError, 'error');
  }
});

module.exports = ReactDOMImg;

},{"./EventConstants":15,"./LocalEventTrapMixin":24,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52}],43:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMInput
 */

"use strict";

var AutoFocusMixin = require("./AutoFocusMixin");
var DOMPropertyOperations = require("./DOMPropertyOperations");
var LinkedValueUtils = require("./LinkedValueUtils");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");
var ReactMount = require("./ReactMount");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");
var invariant = require("./invariant");

// Store a reference to the <input> `ReactDOMComponent`. TODO: use string
var input = ReactElement.createFactory(ReactDOM.input.type);

var instancesByReactID = {};

function forceUpdateIfMounted() {
  /*jshint validthis:true */
  if (this.isMounted()) {
    this.forceUpdate();
  }
}

/**
 * Implements an <input> native component that allows setting these optional
 * props: `checked`, `value`, `defaultChecked`, and `defaultValue`.
 *
 * If `checked` or `value` are not supplied (or null/undefined), user actions
 * that affect the checked state or value will trigger updates to the element.
 *
 * If they are supplied (and not null/undefined), the rendered element will not
 * trigger updates to the element. Instead, the props must change in order for
 * the rendered element to be updated.
 *
 * The rendered element will be initialized as unchecked (or `defaultChecked`)
 * with an empty value (or `defaultValue`).
 *
 * @see http://www.w3.org/TR/2012/WD-html5-20121025/the-input-element.html
 */
var ReactDOMInput = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMInput',

  mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],

  getInitialState: function() {
    var defaultValue = this.props.defaultValue;
    return {
      initialChecked: this.props.defaultChecked || false,
      initialValue: defaultValue != null ? defaultValue : null
    };
  },

  render: function() {
    // Clone `this.props` so we don't mutate the input.
    var props = assign({}, this.props);

    props.defaultChecked = null;
    props.defaultValue = null;

    var value = LinkedValueUtils.getValue(this);
    props.value = value != null ? value : this.state.initialValue;

    var checked = LinkedValueUtils.getChecked(this);
    props.checked = checked != null ? checked : this.state.initialChecked;

    props.onChange = this._handleChange;

    return input(props, this.props.children);
  },

  componentDidMount: function() {
    var id = ReactMount.getID(this.getDOMNode());
    instancesByReactID[id] = this;
  },

  componentWillUnmount: function() {
    var rootNode = this.getDOMNode();
    var id = ReactMount.getID(rootNode);
    delete instancesByReactID[id];
  },

  componentDidUpdate: function(prevProps, prevState, prevContext) {
    var rootNode = this.getDOMNode();
    if (this.props.checked != null) {
      DOMPropertyOperations.setValueForProperty(
        rootNode,
        'checked',
        this.props.checked || false
      );
    }

    var value = LinkedValueUtils.getValue(this);
    if (value != null) {
      // Cast `value` to a string to ensure the value is set correctly. While
      // browsers typically do this as necessary, jsdom doesn't.
      DOMPropertyOperations.setValueForProperty(rootNode, 'value', '' + value);
    }
  },

  _handleChange: function(event) {
    var returnValue;
    var onChange = LinkedValueUtils.getOnChange(this);
    if (onChange) {
      returnValue = onChange.call(this, event);
    }
    // Here we use asap to wait until all updates have propagated, which
    // is important when using controlled components within layers:
    // https://github.com/facebook/react/issues/1698
    ReactUpdates.asap(forceUpdateIfMounted, this);

    var name = this.props.name;
    if (this.props.type === 'radio' && name != null) {
      var rootNode = this.getDOMNode();
      var queryRoot = rootNode;

      while (queryRoot.parentNode) {
        queryRoot = queryRoot.parentNode;
      }

      // If `rootNode.form` was non-null, then we could try `form.elements`,
      // but that sometimes behaves strangely in IE8. We could also try using
      // `form.getElementsByName`, but that will only return direct children
      // and won't include inputs that use the HTML5 `form=` attribute. Since
      // the input might not even be in a form, let's just use the global
      // `querySelectorAll` to ensure we don't miss anything.
      var group = queryRoot.querySelectorAll(
        'input[name=' + JSON.stringify('' + name) + '][type="radio"]');

      for (var i = 0, groupLen = group.length; i < groupLen; i++) {
        var otherNode = group[i];
        if (otherNode === rootNode ||
            otherNode.form !== rootNode.form) {
          continue;
        }
        var otherID = ReactMount.getID(otherNode);
        ("production" !== process.env.NODE_ENV ? invariant(
          otherID,
          'ReactDOMInput: Mixing React and non-React radio inputs with the ' +
          'same `name` is not supported.'
        ) : invariant(otherID));
        var otherInstance = instancesByReactID[otherID];
        ("production" !== process.env.NODE_ENV ? invariant(
          otherInstance,
          'ReactDOMInput: Unknown radio button ID %s.',
          otherID
        ) : invariant(otherInstance));
        // If this is a controlled radio button group, forcing the input that
        // was previously checked to update will cause it to be come re-checked
        // as appropriate.
        ReactUpdates.asap(forceUpdateIfMounted, otherInstance);
      }
    }

    return returnValue;
  }

});

module.exports = ReactDOMInput;

}).call(this,require('_process'))
},{"./AutoFocusMixin":1,"./DOMPropertyOperations":11,"./LinkedValueUtils":23,"./Object.assign":26,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52,"./ReactMount":63,"./ReactUpdates":79,"./invariant":126,"_process":152}],44:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMOption
 */

"use strict";

var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");

var warning = require("./warning");

// Store a reference to the <option> `ReactDOMComponent`. TODO: use string
var option = ReactElement.createFactory(ReactDOM.option.type);

/**
 * Implements an <option> native component that warns when `selected` is set.
 */
var ReactDOMOption = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMOption',

  mixins: [ReactBrowserComponentMixin],

  componentWillMount: function() {
    // TODO (yungsters): Remove support for `selected` in <option>.
    if ("production" !== process.env.NODE_ENV) {
      ("production" !== process.env.NODE_ENV ? warning(
        this.props.selected == null,
        'Use the `defaultValue` or `value` props on <select> instead of ' +
        'setting `selected` on <option>.'
      ) : null);
    }
  },

  render: function() {
    return option(this.props, this.props.children);
  }

});

module.exports = ReactDOMOption;

}).call(this,require('_process'))
},{"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52,"./warning":145,"_process":152}],45:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMSelect
 */

"use strict";

var AutoFocusMixin = require("./AutoFocusMixin");
var LinkedValueUtils = require("./LinkedValueUtils");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");

// Store a reference to the <select> `ReactDOMComponent`. TODO: use string
var select = ReactElement.createFactory(ReactDOM.select.type);

function updateWithPendingValueIfMounted() {
  /*jshint validthis:true */
  if (this.isMounted()) {
    this.setState({value: this._pendingValue});
    this._pendingValue = 0;
  }
}

/**
 * Validation function for `value` and `defaultValue`.
 * @private
 */
function selectValueType(props, propName, componentName) {
  if (props[propName] == null) {
    return;
  }
  if (props.multiple) {
    if (!Array.isArray(props[propName])) {
      return new Error(
        ("The `" + propName + "` prop supplied to <select> must be an array if ") +
        ("`multiple` is true.")
      );
    }
  } else {
    if (Array.isArray(props[propName])) {
      return new Error(
        ("The `" + propName + "` prop supplied to <select> must be a scalar ") +
        ("value if `multiple` is false.")
      );
    }
  }
}

/**
 * If `value` is supplied, updates <option> elements on mount and update.
 * @param {ReactComponent} component Instance of ReactDOMSelect
 * @param {?*} propValue For uncontrolled components, null/undefined. For
 * controlled components, a string (or with `multiple`, a list of strings).
 * @private
 */
function updateOptions(component, propValue) {
  var multiple = component.props.multiple;
  var value = propValue != null ? propValue : component.state.value;
  var options = component.getDOMNode().options;
  var selectedValue, i, l;
  if (multiple) {
    selectedValue = {};
    for (i = 0, l = value.length; i < l; ++i) {
      selectedValue['' + value[i]] = true;
    }
  } else {
    selectedValue = '' + value;
  }
  for (i = 0, l = options.length; i < l; i++) {
    var selected = multiple ?
      selectedValue.hasOwnProperty(options[i].value) :
      options[i].value === selectedValue;

    if (selected !== options[i].selected) {
      options[i].selected = selected;
    }
  }
}

/**
 * Implements a <select> native component that allows optionally setting the
 * props `value` and `defaultValue`. If `multiple` is false, the prop must be a
 * string. If `multiple` is true, the prop must be an array of strings.
 *
 * If `value` is not supplied (or null/undefined), user actions that change the
 * selected option will trigger updates to the rendered options.
 *
 * If it is supplied (and not null/undefined), the rendered options will not
 * update in response to user actions. Instead, the `value` prop must change in
 * order for the rendered options to update.
 *
 * If `defaultValue` is provided, any options with the supplied values will be
 * selected.
 */
var ReactDOMSelect = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMSelect',

  mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],

  propTypes: {
    defaultValue: selectValueType,
    value: selectValueType
  },

  getInitialState: function() {
    return {value: this.props.defaultValue || (this.props.multiple ? [] : '')};
  },

  componentWillMount: function() {
    this._pendingValue = null;
  },

  componentWillReceiveProps: function(nextProps) {
    if (!this.props.multiple && nextProps.multiple) {
      this.setState({value: [this.state.value]});
    } else if (this.props.multiple && !nextProps.multiple) {
      this.setState({value: this.state.value[0]});
    }
  },

  render: function() {
    // Clone `this.props` so we don't mutate the input.
    var props = assign({}, this.props);

    props.onChange = this._handleChange;
    props.value = null;

    return select(props, this.props.children);
  },

  componentDidMount: function() {
    updateOptions(this, LinkedValueUtils.getValue(this));
  },

  componentDidUpdate: function(prevProps) {
    var value = LinkedValueUtils.getValue(this);
    var prevMultiple = !!prevProps.multiple;
    var multiple = !!this.props.multiple;
    if (value != null || prevMultiple !== multiple) {
      updateOptions(this, value);
    }
  },

  _handleChange: function(event) {
    var returnValue;
    var onChange = LinkedValueUtils.getOnChange(this);
    if (onChange) {
      returnValue = onChange.call(this, event);
    }

    var selectedValue;
    if (this.props.multiple) {
      selectedValue = [];
      var options = event.target.options;
      for (var i = 0, l = options.length; i < l; i++) {
        if (options[i].selected) {
          selectedValue.push(options[i].value);
        }
      }
    } else {
      selectedValue = event.target.value;
    }

    this._pendingValue = selectedValue;
    ReactUpdates.asap(updateWithPendingValueIfMounted, this);
    return returnValue;
  }

});

module.exports = ReactDOMSelect;

},{"./AutoFocusMixin":1,"./LinkedValueUtils":23,"./Object.assign":26,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52,"./ReactUpdates":79}],46:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMSelection
 */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var getNodeForCharacterOffset = require("./getNodeForCharacterOffset");
var getTextContentAccessor = require("./getTextContentAccessor");

/**
 * While `isCollapsed` is available on the Selection object and `collapsed`
 * is available on the Range object, IE11 sometimes gets them wrong.
 * If the anchor/focus nodes and offsets are the same, the range is collapsed.
 */
function isCollapsed(anchorNode, anchorOffset, focusNode, focusOffset) {
  return anchorNode === focusNode && anchorOffset === focusOffset;
}

/**
 * Get the appropriate anchor and focus node/offset pairs for IE.
 *
 * The catch here is that IE's selection API doesn't provide information
 * about whether the selection is forward or backward, so we have to
 * behave as though it's always forward.
 *
 * IE text differs from modern selection in that it behaves as though
 * block elements end with a new line. This means character offsets will
 * differ between the two APIs.
 *
 * @param {DOMElement} node
 * @return {object}
 */
function getIEOffsets(node) {
  var selection = document.selection;
  var selectedRange = selection.createRange();
  var selectedLength = selectedRange.text.length;

  // Duplicate selection so we can move range without breaking user selection.
  var fromStart = selectedRange.duplicate();
  fromStart.moveToElementText(node);
  fromStart.setEndPoint('EndToStart', selectedRange);

  var startOffset = fromStart.text.length;
  var endOffset = startOffset + selectedLength;

  return {
    start: startOffset,
    end: endOffset
  };
}

/**
 * @param {DOMElement} node
 * @return {?object}
 */
function getModernOffsets(node) {
  var selection = window.getSelection && window.getSelection();

  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  var anchorNode = selection.anchorNode;
  var anchorOffset = selection.anchorOffset;
  var focusNode = selection.focusNode;
  var focusOffset = selection.focusOffset;

  var currentRange = selection.getRangeAt(0);

  // If the node and offset values are the same, the selection is collapsed.
  // `Selection.isCollapsed` is available natively, but IE sometimes gets
  // this value wrong.
  var isSelectionCollapsed = isCollapsed(
    selection.anchorNode,
    selection.anchorOffset,
    selection.focusNode,
    selection.focusOffset
  );

  var rangeLength = isSelectionCollapsed ? 0 : currentRange.toString().length;

  var tempRange = currentRange.cloneRange();
  tempRange.selectNodeContents(node);
  tempRange.setEnd(currentRange.startContainer, currentRange.startOffset);

  var isTempRangeCollapsed = isCollapsed(
    tempRange.startContainer,
    tempRange.startOffset,
    tempRange.endContainer,
    tempRange.endOffset
  );

  var start = isTempRangeCollapsed ? 0 : tempRange.toString().length;
  var end = start + rangeLength;

  // Detect whether the selection is backward.
  var detectionRange = document.createRange();
  detectionRange.setStart(anchorNode, anchorOffset);
  detectionRange.setEnd(focusNode, focusOffset);
  var isBackward = detectionRange.collapsed;

  return {
    start: isBackward ? end : start,
    end: isBackward ? start : end
  };
}

/**
 * @param {DOMElement|DOMTextNode} node
 * @param {object} offsets
 */
function setIEOffsets(node, offsets) {
  var range = document.selection.createRange().duplicate();
  var start, end;

  if (typeof offsets.end === 'undefined') {
    start = offsets.start;
    end = start;
  } else if (offsets.start > offsets.end) {
    start = offsets.end;
    end = offsets.start;
  } else {
    start = offsets.start;
    end = offsets.end;
  }

  range.moveToElementText(node);
  range.moveStart('character', start);
  range.setEndPoint('EndToStart', range);
  range.moveEnd('character', end - start);
  range.select();
}

/**
 * In modern non-IE browsers, we can support both forward and backward
 * selections.
 *
 * Note: IE10+ supports the Selection object, but it does not support
 * the `extend` method, which means that even in modern IE, it's not possible
 * to programatically create a backward selection. Thus, for all IE
 * versions, we use the old IE API to create our selections.
 *
 * @param {DOMElement|DOMTextNode} node
 * @param {object} offsets
 */
function setModernOffsets(node, offsets) {
  if (!window.getSelection) {
    return;
  }

  var selection = window.getSelection();
  var length = node[getTextContentAccessor()].length;
  var start = Math.min(offsets.start, length);
  var end = typeof offsets.end === 'undefined' ?
            start : Math.min(offsets.end, length);

  // IE 11 uses modern selection, but doesn't support the extend method.
  // Flip backward selections, so we can set with a single range.
  if (!selection.extend && start > end) {
    var temp = end;
    end = start;
    start = temp;
  }

  var startMarker = getNodeForCharacterOffset(node, start);
  var endMarker = getNodeForCharacterOffset(node, end);

  if (startMarker && endMarker) {
    var range = document.createRange();
    range.setStart(startMarker.node, startMarker.offset);
    selection.removeAllRanges();

    if (start > end) {
      selection.addRange(range);
      selection.extend(endMarker.node, endMarker.offset);
    } else {
      range.setEnd(endMarker.node, endMarker.offset);
      selection.addRange(range);
    }
  }
}

var useIEOffsets = ExecutionEnvironment.canUseDOM && document.selection;

var ReactDOMSelection = {
  /**
   * @param {DOMElement} node
   */
  getOffsets: useIEOffsets ? getIEOffsets : getModernOffsets,

  /**
   * @param {DOMElement|DOMTextNode} node
   * @param {object} offsets
   */
  setOffsets: useIEOffsets ? setIEOffsets : setModernOffsets
};

module.exports = ReactDOMSelection;

},{"./ExecutionEnvironment":21,"./getNodeForCharacterOffset":119,"./getTextContentAccessor":121}],47:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMTextarea
 */

"use strict";

var AutoFocusMixin = require("./AutoFocusMixin");
var DOMPropertyOperations = require("./DOMPropertyOperations");
var LinkedValueUtils = require("./LinkedValueUtils");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");
var invariant = require("./invariant");

var warning = require("./warning");

// Store a reference to the <textarea> `ReactDOMComponent`. TODO: use string
var textarea = ReactElement.createFactory(ReactDOM.textarea.type);

function forceUpdateIfMounted() {
  /*jshint validthis:true */
  if (this.isMounted()) {
    this.forceUpdate();
  }
}

/**
 * Implements a <textarea> native component that allows setting `value`, and
 * `defaultValue`. This differs from the traditional DOM API because value is
 * usually set as PCDATA children.
 *
 * If `value` is not supplied (or null/undefined), user actions that affect the
 * value will trigger updates to the element.
 *
 * If `value` is supplied (and not null/undefined), the rendered element will
 * not trigger updates to the element. Instead, the `value` prop must change in
 * order for the rendered element to be updated.
 *
 * The rendered element will be initialized with an empty value, the prop
 * `defaultValue` if specified, or the children content (deprecated).
 */
var ReactDOMTextarea = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMTextarea',

  mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],

  getInitialState: function() {
    var defaultValue = this.props.defaultValue;
    // TODO (yungsters): Remove support for children content in <textarea>.
    var children = this.props.children;
    if (children != null) {
      if ("production" !== process.env.NODE_ENV) {
        ("production" !== process.env.NODE_ENV ? warning(
          false,
          'Use the `defaultValue` or `value` props instead of setting ' +
          'children on <textarea>.'
        ) : null);
      }
      ("production" !== process.env.NODE_ENV ? invariant(
        defaultValue == null,
        'If you supply `defaultValue` on a <textarea>, do not pass children.'
      ) : invariant(defaultValue == null));
      if (Array.isArray(children)) {
        ("production" !== process.env.NODE_ENV ? invariant(
          children.length <= 1,
          '<textarea> can only have at most one child.'
        ) : invariant(children.length <= 1));
        children = children[0];
      }

      defaultValue = '' + children;
    }
    if (defaultValue == null) {
      defaultValue = '';
    }
    var value = LinkedValueUtils.getValue(this);
    return {
      // We save the initial value so that `ReactDOMComponent` doesn't update
      // `textContent` (unnecessary since we update value).
      // The initial value can be a boolean or object so that's why it's
      // forced to be a string.
      initialValue: '' + (value != null ? value : defaultValue)
    };
  },

  render: function() {
    // Clone `this.props` so we don't mutate the input.
    var props = assign({}, this.props);

    ("production" !== process.env.NODE_ENV ? invariant(
      props.dangerouslySetInnerHTML == null,
      '`dangerouslySetInnerHTML` does not make sense on <textarea>.'
    ) : invariant(props.dangerouslySetInnerHTML == null));

    props.defaultValue = null;
    props.value = null;
    props.onChange = this._handleChange;

    // Always set children to the same thing. In IE9, the selection range will
    // get reset if `textContent` is mutated.
    return textarea(props, this.state.initialValue);
  },

  componentDidUpdate: function(prevProps, prevState, prevContext) {
    var value = LinkedValueUtils.getValue(this);
    if (value != null) {
      var rootNode = this.getDOMNode();
      // Cast `value` to a string to ensure the value is set correctly. While
      // browsers typically do this as necessary, jsdom doesn't.
      DOMPropertyOperations.setValueForProperty(rootNode, 'value', '' + value);
    }
  },

  _handleChange: function(event) {
    var returnValue;
    var onChange = LinkedValueUtils.getOnChange(this);
    if (onChange) {
      returnValue = onChange.call(this, event);
    }
    ReactUpdates.asap(forceUpdateIfMounted, this);
    return returnValue;
  }

});

module.exports = ReactDOMTextarea;

}).call(this,require('_process'))
},{"./AutoFocusMixin":1,"./DOMPropertyOperations":11,"./LinkedValueUtils":23,"./Object.assign":26,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52,"./ReactUpdates":79,"./invariant":126,"./warning":145,"_process":152}],48:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDefaultBatchingStrategy
 */

"use strict";

var ReactUpdates = require("./ReactUpdates");
var Transaction = require("./Transaction");

var assign = require("./Object.assign");
var emptyFunction = require("./emptyFunction");

var RESET_BATCHED_UPDATES = {
  initialize: emptyFunction,
  close: function() {
    ReactDefaultBatchingStrategy.isBatchingUpdates = false;
  }
};

var FLUSH_BATCHED_UPDATES = {
  initialize: emptyFunction,
  close: ReactUpdates.flushBatchedUpdates.bind(ReactUpdates)
};

var TRANSACTION_WRAPPERS = [FLUSH_BATCHED_UPDATES, RESET_BATCHED_UPDATES];

function ReactDefaultBatchingStrategyTransaction() {
  this.reinitializeTransaction();
}

assign(
  ReactDefaultBatchingStrategyTransaction.prototype,
  Transaction.Mixin,
  {
    getTransactionWrappers: function() {
      return TRANSACTION_WRAPPERS;
    }
  }
);

var transaction = new ReactDefaultBatchingStrategyTransaction();

var ReactDefaultBatchingStrategy = {
  isBatchingUpdates: false,

  /**
   * Call the provided function in a context within which calls to `setState`
   * and friends are batched such that components aren't updated unnecessarily.
   */
  batchedUpdates: function(callback, a, b) {
    var alreadyBatchingUpdates = ReactDefaultBatchingStrategy.isBatchingUpdates;

    ReactDefaultBatchingStrategy.isBatchingUpdates = true;

    // The code is written this way to avoid extra allocations
    if (alreadyBatchingUpdates) {
      callback(a, b);
    } else {
      transaction.perform(callback, null, a, b);
    }
  }
};

module.exports = ReactDefaultBatchingStrategy;

},{"./Object.assign":26,"./ReactUpdates":79,"./Transaction":95,"./emptyFunction":107}],49:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDefaultInjection
 */

"use strict";

var BeforeInputEventPlugin = require("./BeforeInputEventPlugin");
var ChangeEventPlugin = require("./ChangeEventPlugin");
var ClientReactRootIndex = require("./ClientReactRootIndex");
var CompositionEventPlugin = require("./CompositionEventPlugin");
var DefaultEventPluginOrder = require("./DefaultEventPluginOrder");
var EnterLeaveEventPlugin = require("./EnterLeaveEventPlugin");
var ExecutionEnvironment = require("./ExecutionEnvironment");
var HTMLDOMPropertyConfig = require("./HTMLDOMPropertyConfig");
var MobileSafariClickEventPlugin = require("./MobileSafariClickEventPlugin");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactComponentBrowserEnvironment =
  require("./ReactComponentBrowserEnvironment");
var ReactDefaultBatchingStrategy = require("./ReactDefaultBatchingStrategy");
var ReactDOMComponent = require("./ReactDOMComponent");
var ReactDOMButton = require("./ReactDOMButton");
var ReactDOMForm = require("./ReactDOMForm");
var ReactDOMImg = require("./ReactDOMImg");
var ReactDOMInput = require("./ReactDOMInput");
var ReactDOMOption = require("./ReactDOMOption");
var ReactDOMSelect = require("./ReactDOMSelect");
var ReactDOMTextarea = require("./ReactDOMTextarea");
var ReactEventListener = require("./ReactEventListener");
var ReactInjection = require("./ReactInjection");
var ReactInstanceHandles = require("./ReactInstanceHandles");
var ReactMount = require("./ReactMount");
var SelectEventPlugin = require("./SelectEventPlugin");
var ServerReactRootIndex = require("./ServerReactRootIndex");
var SimpleEventPlugin = require("./SimpleEventPlugin");
var SVGDOMPropertyConfig = require("./SVGDOMPropertyConfig");

var createFullPageComponent = require("./createFullPageComponent");

function inject() {
  ReactInjection.EventEmitter.injectReactEventListener(
    ReactEventListener
  );

  /**
   * Inject modules for resolving DOM hierarchy and plugin ordering.
   */
  ReactInjection.EventPluginHub.injectEventPluginOrder(DefaultEventPluginOrder);
  ReactInjection.EventPluginHub.injectInstanceHandle(ReactInstanceHandles);
  ReactInjection.EventPluginHub.injectMount(ReactMount);

  /**
   * Some important event plugins included by default (without having to require
   * them).
   */
  ReactInjection.EventPluginHub.injectEventPluginsByName({
    SimpleEventPlugin: SimpleEventPlugin,
    EnterLeaveEventPlugin: EnterLeaveEventPlugin,
    ChangeEventPlugin: ChangeEventPlugin,
    CompositionEventPlugin: CompositionEventPlugin,
    MobileSafariClickEventPlugin: MobileSafariClickEventPlugin,
    SelectEventPlugin: SelectEventPlugin,
    BeforeInputEventPlugin: BeforeInputEventPlugin
  });

  ReactInjection.NativeComponent.injectGenericComponentClass(
    ReactDOMComponent
  );

  ReactInjection.NativeComponent.injectComponentClasses({
    'button': ReactDOMButton,
    'form': ReactDOMForm,
    'img': ReactDOMImg,
    'input': ReactDOMInput,
    'option': ReactDOMOption,
    'select': ReactDOMSelect,
    'textarea': ReactDOMTextarea,

    'html': createFullPageComponent('html'),
    'head': createFullPageComponent('head'),
    'body': createFullPageComponent('body')
  });

  // This needs to happen after createFullPageComponent() otherwise the mixin
  // gets double injected.
  ReactInjection.CompositeComponent.injectMixin(ReactBrowserComponentMixin);

  ReactInjection.DOMProperty.injectDOMPropertyConfig(HTMLDOMPropertyConfig);
  ReactInjection.DOMProperty.injectDOMPropertyConfig(SVGDOMPropertyConfig);

  ReactInjection.EmptyComponent.injectEmptyComponent('noscript');

  ReactInjection.Updates.injectReconcileTransaction(
    ReactComponentBrowserEnvironment.ReactReconcileTransaction
  );
  ReactInjection.Updates.injectBatchingStrategy(
    ReactDefaultBatchingStrategy
  );

  ReactInjection.RootIndex.injectCreateReactRootIndex(
    ExecutionEnvironment.canUseDOM ?
      ClientReactRootIndex.createReactRootIndex :
      ServerReactRootIndex.createReactRootIndex
  );

  ReactInjection.Component.injectEnvironment(ReactComponentBrowserEnvironment);

  if ("production" !== process.env.NODE_ENV) {
    var url = (ExecutionEnvironment.canUseDOM && window.location.href) || '';
    if ((/[?&]react_perf\b/).test(url)) {
      var ReactDefaultPerf = require("./ReactDefaultPerf");
      ReactDefaultPerf.start();
    }
  }
}

module.exports = {
  inject: inject
};

}).call(this,require('_process'))
},{"./BeforeInputEventPlugin":2,"./ChangeEventPlugin":6,"./ClientReactRootIndex":7,"./CompositionEventPlugin":8,"./DefaultEventPluginOrder":13,"./EnterLeaveEventPlugin":14,"./ExecutionEnvironment":21,"./HTMLDOMPropertyConfig":22,"./MobileSafariClickEventPlugin":25,"./ReactBrowserComponentMixin":29,"./ReactComponentBrowserEnvironment":33,"./ReactDOMButton":38,"./ReactDOMComponent":39,"./ReactDOMForm":40,"./ReactDOMImg":42,"./ReactDOMInput":43,"./ReactDOMOption":44,"./ReactDOMSelect":45,"./ReactDOMTextarea":47,"./ReactDefaultBatchingStrategy":48,"./ReactDefaultPerf":50,"./ReactEventListener":57,"./ReactInjection":58,"./ReactInstanceHandles":60,"./ReactMount":63,"./SVGDOMPropertyConfig":80,"./SelectEventPlugin":81,"./ServerReactRootIndex":82,"./SimpleEventPlugin":83,"./createFullPageComponent":103,"_process":152}],50:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDefaultPerf
 * @typechecks static-only
 */

"use strict";

var DOMProperty = require("./DOMProperty");
var ReactDefaultPerfAnalysis = require("./ReactDefaultPerfAnalysis");
var ReactMount = require("./ReactMount");
var ReactPerf = require("./ReactPerf");

var performanceNow = require("./performanceNow");

function roundFloat(val) {
  return Math.floor(val * 100) / 100;
}

function addValue(obj, key, val) {
  obj[key] = (obj[key] || 0) + val;
}

var ReactDefaultPerf = {
  _allMeasurements: [], // last item in the list is the current one
  _mountStack: [0],
  _injected: false,

  start: function() {
    if (!ReactDefaultPerf._injected) {
      ReactPerf.injection.injectMeasure(ReactDefaultPerf.measure);
    }

    ReactDefaultPerf._allMeasurements.length = 0;
    ReactPerf.enableMeasure = true;
  },

  stop: function() {
    ReactPerf.enableMeasure = false;
  },

  getLastMeasurements: function() {
    return ReactDefaultPerf._allMeasurements;
  },

  printExclusive: function(measurements) {
    measurements = measurements || ReactDefaultPerf._allMeasurements;
    var summary = ReactDefaultPerfAnalysis.getExclusiveSummary(measurements);
    console.table(summary.map(function(item) {
      return {
        'Component class name': item.componentName,
        'Total inclusive time (ms)': roundFloat(item.inclusive),
        'Exclusive mount time (ms)': roundFloat(item.exclusive),
        'Exclusive render time (ms)': roundFloat(item.render),
        'Mount time per instance (ms)': roundFloat(item.exclusive / item.count),
        'Render time per instance (ms)': roundFloat(item.render / item.count),
        'Instances': item.count
      };
    }));
    // TODO: ReactDefaultPerfAnalysis.getTotalTime() does not return the correct
    // number.
  },

  printInclusive: function(measurements) {
    measurements = measurements || ReactDefaultPerf._allMeasurements;
    var summary = ReactDefaultPerfAnalysis.getInclusiveSummary(measurements);
    console.table(summary.map(function(item) {
      return {
        'Owner > component': item.componentName,
        'Inclusive time (ms)': roundFloat(item.time),
        'Instances': item.count
      };
    }));
    console.log(
      'Total time:',
      ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms'
    );
  },

  getMeasurementsSummaryMap: function(measurements) {
    var summary = ReactDefaultPerfAnalysis.getInclusiveSummary(
      measurements,
      true
    );
    return summary.map(function(item) {
      return {
        'Owner > component': item.componentName,
        'Wasted time (ms)': item.time,
        'Instances': item.count
      };
    });
  },

  printWasted: function(measurements) {
    measurements = measurements || ReactDefaultPerf._allMeasurements;
    console.table(ReactDefaultPerf.getMeasurementsSummaryMap(measurements));
    console.log(
      'Total time:',
      ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms'
    );
  },

  printDOM: function(measurements) {
    measurements = measurements || ReactDefaultPerf._allMeasurements;
    var summary = ReactDefaultPerfAnalysis.getDOMSummary(measurements);
    console.table(summary.map(function(item) {
      var result = {};
      result[DOMProperty.ID_ATTRIBUTE_NAME] = item.id;
      result['type'] = item.type;
      result['args'] = JSON.stringify(item.args);
      return result;
    }));
    console.log(
      'Total time:',
      ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms'
    );
  },

  _recordWrite: function(id, fnName, totalTime, args) {
    // TODO: totalTime isn't that useful since it doesn't count paints/reflows
    var writes =
      ReactDefaultPerf
        ._allMeasurements[ReactDefaultPerf._allMeasurements.length - 1]
        .writes;
    writes[id] = writes[id] || [];
    writes[id].push({
      type: fnName,
      time: totalTime,
      args: args
    });
  },

  measure: function(moduleName, fnName, func) {
    return function() {for (var args=[],$__0=0,$__1=arguments.length;$__0<$__1;$__0++) args.push(arguments[$__0]);
      var totalTime;
      var rv;
      var start;

      if (fnName === '_renderNewRootComponent' ||
          fnName === 'flushBatchedUpdates') {
        // A "measurement" is a set of metrics recorded for each flush. We want
        // to group the metrics for a given flush together so we can look at the
        // components that rendered and the DOM operations that actually
        // happened to determine the amount of "wasted work" performed.
        ReactDefaultPerf._allMeasurements.push({
          exclusive: {},
          inclusive: {},
          render: {},
          counts: {},
          writes: {},
          displayNames: {},
          totalTime: 0
        });
        start = performanceNow();
        rv = func.apply(this, args);
        ReactDefaultPerf._allMeasurements[
          ReactDefaultPerf._allMeasurements.length - 1
        ].totalTime = performanceNow() - start;
        return rv;
      } else if (moduleName === 'ReactDOMIDOperations' ||
        moduleName === 'ReactComponentBrowserEnvironment') {
        start = performanceNow();
        rv = func.apply(this, args);
        totalTime = performanceNow() - start;

        if (fnName === 'mountImageIntoNode') {
          var mountID = ReactMount.getID(args[1]);
          ReactDefaultPerf._recordWrite(mountID, fnName, totalTime, args[0]);
        } else if (fnName === 'dangerouslyProcessChildrenUpdates') {
          // special format
          args[0].forEach(function(update) {
            var writeArgs = {};
            if (update.fromIndex !== null) {
              writeArgs.fromIndex = update.fromIndex;
            }
            if (update.toIndex !== null) {
              writeArgs.toIndex = update.toIndex;
            }
            if (update.textContent !== null) {
              writeArgs.textContent = update.textContent;
            }
            if (update.markupIndex !== null) {
              writeArgs.markup = args[1][update.markupIndex];
            }
            ReactDefaultPerf._recordWrite(
              update.parentID,
              update.type,
              totalTime,
              writeArgs
            );
          });
        } else {
          // basic format
          ReactDefaultPerf._recordWrite(
            args[0],
            fnName,
            totalTime,
            Array.prototype.slice.call(args, 1)
          );
        }
        return rv;
      } else if (moduleName === 'ReactCompositeComponent' && (
        fnName === 'mountComponent' ||
        fnName === 'updateComponent' || // TODO: receiveComponent()?
        fnName === '_renderValidatedComponent')) {

        var rootNodeID = fnName === 'mountComponent' ?
          args[0] :
          this._rootNodeID;
        var isRender = fnName === '_renderValidatedComponent';
        var isMount = fnName === 'mountComponent';

        var mountStack = ReactDefaultPerf._mountStack;
        var entry = ReactDefaultPerf._allMeasurements[
          ReactDefaultPerf._allMeasurements.length - 1
        ];

        if (isRender) {
          addValue(entry.counts, rootNodeID, 1);
        } else if (isMount) {
          mountStack.push(0);
        }

        start = performanceNow();
        rv = func.apply(this, args);
        totalTime = performanceNow() - start;

        if (isRender) {
          addValue(entry.render, rootNodeID, totalTime);
        } else if (isMount) {
          var subMountTime = mountStack.pop();
          mountStack[mountStack.length - 1] += totalTime;
          addValue(entry.exclusive, rootNodeID, totalTime - subMountTime);
          addValue(entry.inclusive, rootNodeID, totalTime);
        } else {
          addValue(entry.inclusive, rootNodeID, totalTime);
        }

        entry.displayNames[rootNodeID] = {
          current: this.constructor.displayName,
          owner: this._owner ? this._owner.constructor.displayName : '<root>'
        };

        return rv;
      } else {
        return func.apply(this, args);
      }
    };
  }
};

module.exports = ReactDefaultPerf;

},{"./DOMProperty":10,"./ReactDefaultPerfAnalysis":51,"./ReactMount":63,"./ReactPerf":68,"./performanceNow":139}],51:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDefaultPerfAnalysis
 */

var assign = require("./Object.assign");

// Don't try to save users less than 1.2ms (a number I made up)
var DONT_CARE_THRESHOLD = 1.2;
var DOM_OPERATION_TYPES = {
  'mountImageIntoNode': 'set innerHTML',
  INSERT_MARKUP: 'set innerHTML',
  MOVE_EXISTING: 'move',
  REMOVE_NODE: 'remove',
  TEXT_CONTENT: 'set textContent',
  'updatePropertyByID': 'update attribute',
  'deletePropertyByID': 'delete attribute',
  'updateStylesByID': 'update styles',
  'updateInnerHTMLByID': 'set innerHTML',
  'dangerouslyReplaceNodeWithMarkupByID': 'replace'
};

function getTotalTime(measurements) {
  // TODO: return number of DOM ops? could be misleading.
  // TODO: measure dropped frames after reconcile?
  // TODO: log total time of each reconcile and the top-level component
  // class that triggered it.
  var totalTime = 0;
  for (var i = 0; i < measurements.length; i++) {
    var measurement = measurements[i];
    totalTime += measurement.totalTime;
  }
  return totalTime;
}

function getDOMSummary(measurements) {
  var items = [];
  for (var i = 0; i < measurements.length; i++) {
    var measurement = measurements[i];
    var id;

    for (id in measurement.writes) {
      measurement.writes[id].forEach(function(write) {
        items.push({
          id: id,
          type: DOM_OPERATION_TYPES[write.type] || write.type,
          args: write.args
        });
      });
    }
  }
  return items;
}

function getExclusiveSummary(measurements) {
  var candidates = {};
  var displayName;

  for (var i = 0; i < measurements.length; i++) {
    var measurement = measurements[i];
    var allIDs = assign(
      {},
      measurement.exclusive,
      measurement.inclusive
    );

    for (var id in allIDs) {
      displayName = measurement.displayNames[id].current;

      candidates[displayName] = candidates[displayName] || {
        componentName: displayName,
        inclusive: 0,
        exclusive: 0,
        render: 0,
        count: 0
      };
      if (measurement.render[id]) {
        candidates[displayName].render += measurement.render[id];
      }
      if (measurement.exclusive[id]) {
        candidates[displayName].exclusive += measurement.exclusive[id];
      }
      if (measurement.inclusive[id]) {
        candidates[displayName].inclusive += measurement.inclusive[id];
      }
      if (measurement.counts[id]) {
        candidates[displayName].count += measurement.counts[id];
      }
    }
  }

  // Now make a sorted array with the results.
  var arr = [];
  for (displayName in candidates) {
    if (candidates[displayName].exclusive >= DONT_CARE_THRESHOLD) {
      arr.push(candidates[displayName]);
    }
  }

  arr.sort(function(a, b) {
    return b.exclusive - a.exclusive;
  });

  return arr;
}

function getInclusiveSummary(measurements, onlyClean) {
  var candidates = {};
  var inclusiveKey;

  for (var i = 0; i < measurements.length; i++) {
    var measurement = measurements[i];
    var allIDs = assign(
      {},
      measurement.exclusive,
      measurement.inclusive
    );
    var cleanComponents;

    if (onlyClean) {
      cleanComponents = getUnchangedComponents(measurement);
    }

    for (var id in allIDs) {
      if (onlyClean && !cleanComponents[id]) {
        continue;
      }

      var displayName = measurement.displayNames[id];

      // Inclusive time is not useful for many components without knowing where
      // they are instantiated. So we aggregate inclusive time with both the
      // owner and current displayName as the key.
      inclusiveKey = displayName.owner + ' > ' + displayName.current;

      candidates[inclusiveKey] = candidates[inclusiveKey] || {
        componentName: inclusiveKey,
        time: 0,
        count: 0
      };

      if (measurement.inclusive[id]) {
        candidates[inclusiveKey].time += measurement.inclusive[id];
      }
      if (measurement.counts[id]) {
        candidates[inclusiveKey].count += measurement.counts[id];
      }
    }
  }

  // Now make a sorted array with the results.
  var arr = [];
  for (inclusiveKey in candidates) {
    if (candidates[inclusiveKey].time >= DONT_CARE_THRESHOLD) {
      arr.push(candidates[inclusiveKey]);
    }
  }

  arr.sort(function(a, b) {
    return b.time - a.time;
  });

  return arr;
}

function getUnchangedComponents(measurement) {
  // For a given reconcile, look at which components did not actually
  // render anything to the DOM and return a mapping of their ID to
  // the amount of time it took to render the entire subtree.
  var cleanComponents = {};
  var dirtyLeafIDs = Object.keys(measurement.writes);
  var allIDs = assign({}, measurement.exclusive, measurement.inclusive);

  for (var id in allIDs) {
    var isDirty = false;
    // For each component that rendered, see if a component that triggered
    // a DOM op is in its subtree.
    for (var i = 0; i < dirtyLeafIDs.length; i++) {
      if (dirtyLeafIDs[i].indexOf(id) === 0) {
        isDirty = true;
        break;
      }
    }
    if (!isDirty && measurement.counts[id] > 0) {
      cleanComponents[id] = true;
    }
  }
  return cleanComponents;
}

var ReactDefaultPerfAnalysis = {
  getExclusiveSummary: getExclusiveSummary,
  getInclusiveSummary: getInclusiveSummary,
  getDOMSummary: getDOMSummary,
  getTotalTime: getTotalTime
};

module.exports = ReactDefaultPerfAnalysis;

},{"./Object.assign":26}],52:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactElement
 */

"use strict";

var ReactContext = require("./ReactContext");
var ReactCurrentOwner = require("./ReactCurrentOwner");

var warning = require("./warning");

var RESERVED_PROPS = {
  key: true,
  ref: true
};

/**
 * Warn for mutations.
 *
 * @internal
 * @param {object} object
 * @param {string} key
 */
function defineWarningProperty(object, key) {
  Object.defineProperty(object, key, {

    configurable: false,
    enumerable: true,

    get: function() {
      if (!this._store) {
        return null;
      }
      return this._store[key];
    },

    set: function(value) {
      ("production" !== process.env.NODE_ENV ? warning(
        false,
        'Don\'t set the ' + key + ' property of the component. ' +
        'Mutate the existing props object instead.'
      ) : null);
      this._store[key] = value;
    }

  });
}

/**
 * This is updated to true if the membrane is successfully created.
 */
var useMutationMembrane = false;

/**
 * Warn for mutations.
 *
 * @internal
 * @param {object} element
 */
function defineMutationMembrane(prototype) {
  try {
    var pseudoFrozenProperties = {
      props: true
    };
    for (var key in pseudoFrozenProperties) {
      defineWarningProperty(prototype, key);
    }
    useMutationMembrane = true;
  } catch (x) {
    // IE will fail on defineProperty
  }
}

/**
 * Base constructor for all React elements. This is only used to make this
 * work with a dynamic instanceof check. Nothing should live on this prototype.
 *
 * @param {*} type
 * @param {string|object} ref
 * @param {*} key
 * @param {*} props
 * @internal
 */
var ReactElement = function(type, key, ref, owner, context, props) {
  // Built-in properties that belong on the element
  this.type = type;
  this.key = key;
  this.ref = ref;

  // Record the component responsible for creating this element.
  this._owner = owner;

  // TODO: Deprecate withContext, and then the context becomes accessible
  // through the owner.
  this._context = context;

  if ("production" !== process.env.NODE_ENV) {
    // The validation flag and props are currently mutative. We put them on
    // an external backing store so that we can freeze the whole object.
    // This can be replaced with a WeakMap once they are implemented in
    // commonly used development environments.
    this._store = { validated: false, props: props };

    // We're not allowed to set props directly on the object so we early
    // return and rely on the prototype membrane to forward to the backing
    // store.
    if (useMutationMembrane) {
      Object.freeze(this);
      return;
    }
  }

  this.props = props;
};

// We intentionally don't expose the function on the constructor property.
// ReactElement should be indistinguishable from a plain object.
ReactElement.prototype = {
  _isReactElement: true
};

if ("production" !== process.env.NODE_ENV) {
  defineMutationMembrane(ReactElement.prototype);
}

ReactElement.createElement = function(type, config, children) {
  var propName;

  // Reserved names are extracted
  var props = {};

  var key = null;
  var ref = null;

  if (config != null) {
    ref = config.ref === undefined ? null : config.ref;
    if ("production" !== process.env.NODE_ENV) {
      ("production" !== process.env.NODE_ENV ? warning(
        config.key !== null,
        'createElement(...): Encountered component with a `key` of null. In ' +
        'a future version, this will be treated as equivalent to the string ' +
        '\'null\'; instead, provide an explicit key or use undefined.'
      ) : null);
    }
    // TODO: Change this back to `config.key === undefined`
    key = config.key == null ? null : '' + config.key;
    // Remaining properties are added to a new props object
    for (propName in config) {
      if (config.hasOwnProperty(propName) &&
          !RESERVED_PROPS.hasOwnProperty(propName)) {
        props[propName] = config[propName];
      }
    }
  }

  // Children can be more than one argument, and those are transferred onto
  // the newly allocated props object.
  var childrenLength = arguments.length - 2;
  if (childrenLength === 1) {
    props.children = children;
  } else if (childrenLength > 1) {
    var childArray = Array(childrenLength);
    for (var i = 0; i < childrenLength; i++) {
      childArray[i] = arguments[i + 2];
    }
    props.children = childArray;
  }

  // Resolve default props
  if (type.defaultProps) {
    var defaultProps = type.defaultProps;
    for (propName in defaultProps) {
      if (typeof props[propName] === 'undefined') {
        props[propName] = defaultProps[propName];
      }
    }
  }

  return new ReactElement(
    type,
    key,
    ref,
    ReactCurrentOwner.current,
    ReactContext.current,
    props
  );
};

ReactElement.createFactory = function(type) {
  var factory = ReactElement.createElement.bind(null, type);
  // Expose the type on the factory and the prototype so that it can be
  // easily accessed on elements. E.g. <Foo />.type === Foo.type.
  // This should not be named `constructor` since this may not be the function
  // that created the element, and it may not even be a constructor.
  factory.type = type;
  return factory;
};

ReactElement.cloneAndReplaceProps = function(oldElement, newProps) {
  var newElement = new ReactElement(
    oldElement.type,
    oldElement.key,
    oldElement.ref,
    oldElement._owner,
    oldElement._context,
    newProps
  );

  if ("production" !== process.env.NODE_ENV) {
    // If the key on the original is valid, then the clone is valid
    newElement._store.validated = oldElement._store.validated;
  }
  return newElement;
};

/**
 * @param {?object} object
 * @return {boolean} True if `object` is a valid component.
 * @final
 */
ReactElement.isValidElement = function(object) {
  // ReactTestUtils is often used outside of beforeEach where as React is
  // within it. This leads to two different instances of React on the same
  // page. To identify a element from a different React instance we use
  // a flag instead of an instanceof check.
  var isElement = !!(object && object._isReactElement);
  // if (isElement && !(object instanceof ReactElement)) {
  // This is an indicator that you're using multiple versions of React at the
  // same time. This will screw with ownership and stuff. Fix it, please.
  // TODO: We could possibly warn here.
  // }
  return isElement;
};

module.exports = ReactElement;

}).call(this,require('_process'))
},{"./ReactContext":35,"./ReactCurrentOwner":36,"./warning":145,"_process":152}],53:[function(require,module,exports){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactElementValidator
 */

/**
 * ReactElementValidator provides a wrapper around a element factory
 * which validates the props passed to the element. This is intended to be
 * used only in DEV and could be replaced by a static type checker for languages
 * that support it.
 */

"use strict";

var ReactElement = require("./ReactElement");
var ReactPropTypeLocations = require("./ReactPropTypeLocations");
var ReactCurrentOwner = require("./ReactCurrentOwner");

var monitorCodeUse = require("./monitorCodeUse");

/**
 * Warn if there's no key explicitly set on dynamic arrays of children or
 * object keys are not valid. This allows us to keep track of children between
 * updates.
 */
var ownerHasKeyUseWarning = {
  'react_key_warning': {},
  'react_numeric_key_warning': {}
};
var ownerHasMonitoredObjectMap = {};

var loggedTypeFailures = {};

var NUMERIC_PROPERTY_REGEX = /^\d+$/;

/**
 * Gets the current owner's displayName for use in warnings.
 *
 * @internal
 * @return {?string} Display name or undefined
 */
function getCurrentOwnerDisplayName() {
  var current = ReactCurrentOwner.current;
  return current && current.constructor.displayName || undefined;
}

/**
 * Warn if the component doesn't have an explicit key assigned to it.
 * This component is in an array. The array could grow and shrink or be
 * reordered. All children that haven't already been validated are required to
 * have a "key" property assigned to it.
 *
 * @internal
 * @param {ReactComponent} component Component that requires a key.
 * @param {*} parentType component's parent's type.
 */
function validateExplicitKey(component, parentType) {
  if (component._store.validated || component.key != null) {
    return;
  }
  component._store.validated = true;

  warnAndMonitorForKeyUse(
    'react_key_warning',
    'Each child in an array should have a unique "key" prop.',
    component,
    parentType
  );
}

/**
 * Warn if the key is being defined as an object property but has an incorrect
 * value.
 *
 * @internal
 * @param {string} name Property name of the key.
 * @param {ReactComponent} component Component that requires a key.
 * @param {*} parentType component's parent's type.
 */
function validatePropertyKey(name, component, parentType) {
  if (!NUMERIC_PROPERTY_REGEX.test(name)) {
    return;
  }
  warnAndMonitorForKeyUse(
    'react_numeric_key_warning',
    'Child objects should have non-numeric keys so ordering is preserved.',
    component,
    parentType
  );
}

/**
 * Shared warning and monitoring code for the key warnings.
 *
 * @internal
 * @param {string} warningID The id used when logging.
 * @param {string} message The base warning that gets output.
 * @param {ReactComponent} component Component that requires a key.
 * @param {*} parentType component's parent's type.
 */
function warnAndMonitorForKeyUse(warningID, message, component, parentType) {
  var ownerName = getCurrentOwnerDisplayName();
  var parentName = parentType.displayName;

  var useName = ownerName || parentName;
  var memoizer = ownerHasKeyUseWarning[warningID];
  if (memoizer.hasOwnProperty(useName)) {
    return;
  }
  memoizer[useName] = true;

  message += ownerName ?
    (" Check the render method of " + ownerName + ".") :
    (" Check the renderComponent call using <" + parentName + ">.");

  // Usually the current owner is the offender, but if it accepts children as a
  // property, it may be the creator of the child that's responsible for
  // assigning it a key.
  var childOwnerName = null;
  if (component._owner && component._owner !== ReactCurrentOwner.current) {
    // Name of the component that originally created this child.
    childOwnerName = component._owner.constructor.displayName;

    message += (" It was passed a child from " + childOwnerName + ".");
  }

  message += ' See http://fb.me/react-warning-keys for more information.';
  monitorCodeUse(warningID, {
    component: useName,
    componentOwner: childOwnerName
  });
  console.warn(message);
}

/**
 * Log that we're using an object map. We're considering deprecating this
 * feature and replace it with proper Map and ImmutableMap data structures.
 *
 * @internal
 */
function monitorUseOfObjectMap() {
  var currentName = getCurrentOwnerDisplayName() || '';
  if (ownerHasMonitoredObjectMap.hasOwnProperty(currentName)) {
    return;
  }
  ownerHasMonitoredObjectMap[currentName] = true;
  monitorCodeUse('react_object_map_children');
}

/**
 * Ensure that every component either is passed in a static location, in an
 * array with an explicit keys property defined, or in an object literal
 * with valid key property.
 *
 * @internal
 * @param {*} component Statically passed child of any type.
 * @param {*} parentType component's parent's type.
 * @return {boolean}
 */
function validateChildKeys(component, parentType) {
  if (Array.isArray(component)) {
    for (var i = 0; i < component.length; i++) {
      var child = component[i];
      if (ReactElement.isValidElement(child)) {
        validateExplicitKey(child, parentType);
      }
    }
  } else if (ReactElement.isValidElement(component)) {
    // This component was passed in a valid location.
    component._store.validated = true;
  } else if (component && typeof component === 'object') {
    monitorUseOfObjectMap();
    for (var name in component) {
      validatePropertyKey(name, component[name], parentType);
    }
  }
}

/**
 * Assert that the props are valid
 *
 * @param {string} componentName Name of the component for error messages.
 * @param {object} propTypes Map of prop name to a ReactPropType
 * @param {object} props
 * @param {string} location e.g. "prop", "context", "child context"
 * @private
 */
function checkPropTypes(componentName, propTypes, props, location) {
  for (var propName in propTypes) {
    if (propTypes.hasOwnProperty(propName)) {
      var error;
      // Prop type validation may throw. In case they do, we don't want to
      // fail the render phase where it didn't fail before. So we log it.
      // After these have been cleaned up, we'll let them throw.
      try {
        error = propTypes[propName](props, propName, componentName, location);
      } catch (ex) {
        error = ex;
      }
      if (error instanceof Error && !(error.message in loggedTypeFailures)) {
        // Only monitor this failure once because there tends to be a lot of the
        // same error.
        loggedTypeFailures[error.message] = true;
        // This will soon use the warning module
        monitorCodeUse(
          'react_failed_descriptor_type_check',
          { message: error.message }
        );
      }
    }
  }
}

var ReactElementValidator = {

  createElement: function(type, props, children) {
    var element = ReactElement.createElement.apply(this, arguments);

    // The result can be nullish if a mock or a custom function is used.
    // TODO: Drop this when these are no longer allowed as the type argument.
    if (element == null) {
      return element;
    }

    for (var i = 2; i < arguments.length; i++) {
      validateChildKeys(arguments[i], type);
    }

    var name = type.displayName;
    if (type.propTypes) {
      checkPropTypes(
        name,
        type.propTypes,
        element.props,
        ReactPropTypeLocations.prop
      );
    }
    if (type.contextTypes) {
      checkPropTypes(
        name,
        type.contextTypes,
        element._context,
        ReactPropTypeLocations.context
      );
    }
    return element;
  },

  createFactory: function(type) {
    var validatedFactory = ReactElementValidator.createElement.bind(
      null,
      type
    );
    validatedFactory.type = type;
    return validatedFactory;
  }

};

module.exports = ReactElementValidator;

},{"./ReactCurrentOwner":36,"./ReactElement":52,"./ReactPropTypeLocations":71,"./monitorCodeUse":136}],54:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactEmptyComponent
 */

"use strict";

var ReactElement = require("./ReactElement");

var invariant = require("./invariant");

var component;
// This registry keeps track of the React IDs of the components that rendered to
// `null` (in reality a placeholder such as `noscript`)
var nullComponentIdsRegistry = {};

var ReactEmptyComponentInjection = {
  injectEmptyComponent: function(emptyComponent) {
    component = ReactElement.createFactory(emptyComponent);
  }
};

/**
 * @return {ReactComponent} component The injected empty component.
 */
function getEmptyComponent() {
  ("production" !== process.env.NODE_ENV ? invariant(
    component,
    'Trying to return null from a render, but no null placeholder component ' +
    'was injected.'
  ) : invariant(component));
  return component();
}

/**
 * Mark the component as having rendered to null.
 * @param {string} id Component's `_rootNodeID`.
 */
function registerNullComponentID(id) {
  nullComponentIdsRegistry[id] = true;
}

/**
 * Unmark the component as having rendered to null: it renders to something now.
 * @param {string} id Component's `_rootNodeID`.
 */
function deregisterNullComponentID(id) {
  delete nullComponentIdsRegistry[id];
}

/**
 * @param {string} id Component's `_rootNodeID`.
 * @return {boolean} True if the component is rendered to null.
 */
function isNullComponentID(id) {
  return nullComponentIdsRegistry[id];
}

var ReactEmptyComponent = {
  deregisterNullComponentID: deregisterNullComponentID,
  getEmptyComponent: getEmptyComponent,
  injection: ReactEmptyComponentInjection,
  isNullComponentID: isNullComponentID,
  registerNullComponentID: registerNullComponentID
};

module.exports = ReactEmptyComponent;

}).call(this,require('_process'))
},{"./ReactElement":52,"./invariant":126,"_process":152}],55:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactErrorUtils
 * @typechecks
 */

"use strict";

var ReactErrorUtils = {
  /**
   * Creates a guarded version of a function. This is supposed to make debugging
   * of event handlers easier. To aid debugging with the browser's debugger,
   * this currently simply returns the original function.
   *
   * @param {function} func Function to be executed
   * @param {string} name The name of the guard
   * @return {function}
   */
  guard: function(func, name) {
    return func;
  }
};

module.exports = ReactErrorUtils;

},{}],56:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactEventEmitterMixin
 */

"use strict";

var EventPluginHub = require("./EventPluginHub");

function runEventQueueInBatch(events) {
  EventPluginHub.enqueueEvents(events);
  EventPluginHub.processEventQueue();
}

var ReactEventEmitterMixin = {

  /**
   * Streams a fired top-level event to `EventPluginHub` where plugins have the
   * opportunity to create `ReactEvent`s to be dispatched.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {object} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native environment event.
   */
  handleTopLevel: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {
    var events = EventPluginHub.extractEvents(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent
    );

    runEventQueueInBatch(events);
  }
};

module.exports = ReactEventEmitterMixin;

},{"./EventPluginHub":17}],57:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactEventListener
 * @typechecks static-only
 */

"use strict";

var EventListener = require("./EventListener");
var ExecutionEnvironment = require("./ExecutionEnvironment");
var PooledClass = require("./PooledClass");
var ReactInstanceHandles = require("./ReactInstanceHandles");
var ReactMount = require("./ReactMount");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");
var getEventTarget = require("./getEventTarget");
var getUnboundedScrollPosition = require("./getUnboundedScrollPosition");

/**
 * Finds the parent React component of `node`.
 *
 * @param {*} node
 * @return {?DOMEventTarget} Parent container, or `null` if the specified node
 *                           is not nested.
 */
function findParent(node) {
  // TODO: It may be a good idea to cache this to prevent unnecessary DOM
  // traversal, but caching is difficult to do correctly without using a
  // mutation observer to listen for all DOM changes.
  var nodeID = ReactMount.getID(node);
  var rootID = ReactInstanceHandles.getReactRootIDFromNodeID(nodeID);
  var container = ReactMount.findReactContainerForID(rootID);
  var parent = ReactMount.getFirstReactDOM(container);
  return parent;
}

// Used to store ancestor hierarchy in top level callback
function TopLevelCallbackBookKeeping(topLevelType, nativeEvent) {
  this.topLevelType = topLevelType;
  this.nativeEvent = nativeEvent;
  this.ancestors = [];
}
assign(TopLevelCallbackBookKeeping.prototype, {
  destructor: function() {
    this.topLevelType = null;
    this.nativeEvent = null;
    this.ancestors.length = 0;
  }
});
PooledClass.addPoolingTo(
  TopLevelCallbackBookKeeping,
  PooledClass.twoArgumentPooler
);

function handleTopLevelImpl(bookKeeping) {
  var topLevelTarget = ReactMount.getFirstReactDOM(
    getEventTarget(bookKeeping.nativeEvent)
  ) || window;

  // Loop through the hierarchy, in case there's any nested components.
  // It's important that we build the array of ancestors before calling any
  // event handlers, because event handlers can modify the DOM, leading to
  // inconsistencies with ReactMount's node cache. See #1105.
  var ancestor = topLevelTarget;
  while (ancestor) {
    bookKeeping.ancestors.push(ancestor);
    ancestor = findParent(ancestor);
  }

  for (var i = 0, l = bookKeeping.ancestors.length; i < l; i++) {
    topLevelTarget = bookKeeping.ancestors[i];
    var topLevelTargetID = ReactMount.getID(topLevelTarget) || '';
    ReactEventListener._handleTopLevel(
      bookKeeping.topLevelType,
      topLevelTarget,
      topLevelTargetID,
      bookKeeping.nativeEvent
    );
  }
}

function scrollValueMonitor(cb) {
  var scrollPosition = getUnboundedScrollPosition(window);
  cb(scrollPosition);
}

var ReactEventListener = {
  _enabled: true,
  _handleTopLevel: null,

  WINDOW_HANDLE: ExecutionEnvironment.canUseDOM ? window : null,

  setHandleTopLevel: function(handleTopLevel) {
    ReactEventListener._handleTopLevel = handleTopLevel;
  },

  setEnabled: function(enabled) {
    ReactEventListener._enabled = !!enabled;
  },

  isEnabled: function() {
    return ReactEventListener._enabled;
  },


  /**
   * Traps top-level events by using event bubbling.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {string} handlerBaseName Event name (e.g. "click").
   * @param {object} handle Element on which to attach listener.
   * @return {object} An object with a remove function which will forcefully
   *                  remove the listener.
   * @internal
   */
  trapBubbledEvent: function(topLevelType, handlerBaseName, handle) {
    var element = handle;
    if (!element) {
      return;
    }
    return EventListener.listen(
      element,
      handlerBaseName,
      ReactEventListener.dispatchEvent.bind(null, topLevelType)
    );
  },

  /**
   * Traps a top-level event by using event capturing.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {string} handlerBaseName Event name (e.g. "click").
   * @param {object} handle Element on which to attach listener.
   * @return {object} An object with a remove function which will forcefully
   *                  remove the listener.
   * @internal
   */
  trapCapturedEvent: function(topLevelType, handlerBaseName, handle) {
    var element = handle;
    if (!element) {
      return;
    }
    return EventListener.capture(
      element,
      handlerBaseName,
      ReactEventListener.dispatchEvent.bind(null, topLevelType)
    );
  },

  monitorScrollValue: function(refresh) {
    var callback = scrollValueMonitor.bind(null, refresh);
    EventListener.listen(window, 'scroll', callback);
    EventListener.listen(window, 'resize', callback);
  },

  dispatchEvent: function(topLevelType, nativeEvent) {
    if (!ReactEventListener._enabled) {
      return;
    }

    var bookKeeping = TopLevelCallbackBookKeeping.getPooled(
      topLevelType,
      nativeEvent
    );
    try {
      // Event queue being processed in the same cycle allows
      // `preventDefault`.
      ReactUpdates.batchedUpdates(handleTopLevelImpl, bookKeeping);
    } finally {
      TopLevelCallbackBookKeeping.release(bookKeeping);
    }
  }
};

module.exports = ReactEventListener;

},{"./EventListener":16,"./ExecutionEnvironment":21,"./Object.assign":26,"./PooledClass":27,"./ReactInstanceHandles":60,"./ReactMount":63,"./ReactUpdates":79,"./getEventTarget":117,"./getUnboundedScrollPosition":122}],58:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactInjection
 */

"use strict";

var DOMProperty = require("./DOMProperty");
var EventPluginHub = require("./EventPluginHub");
var ReactComponent = require("./ReactComponent");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactEmptyComponent = require("./ReactEmptyComponent");
var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");
var ReactNativeComponent = require("./ReactNativeComponent");
var ReactPerf = require("./ReactPerf");
var ReactRootIndex = require("./ReactRootIndex");
var ReactUpdates = require("./ReactUpdates");

var ReactInjection = {
  Component: ReactComponent.injection,
  CompositeComponent: ReactCompositeComponent.injection,
  DOMProperty: DOMProperty.injection,
  EmptyComponent: ReactEmptyComponent.injection,
  EventPluginHub: EventPluginHub.injection,
  EventEmitter: ReactBrowserEventEmitter.injection,
  NativeComponent: ReactNativeComponent.injection,
  Perf: ReactPerf.injection,
  RootIndex: ReactRootIndex.injection,
  Updates: ReactUpdates.injection
};

module.exports = ReactInjection;

},{"./DOMProperty":10,"./EventPluginHub":17,"./ReactBrowserEventEmitter":30,"./ReactComponent":32,"./ReactCompositeComponent":34,"./ReactEmptyComponent":54,"./ReactNativeComponent":66,"./ReactPerf":68,"./ReactRootIndex":75,"./ReactUpdates":79}],59:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactInputSelection
 */

"use strict";

var ReactDOMSelection = require("./ReactDOMSelection");

var containsNode = require("./containsNode");
var focusNode = require("./focusNode");
var getActiveElement = require("./getActiveElement");

function isInDocument(node) {
  return containsNode(document.documentElement, node);
}

/**
 * @ReactInputSelection: React input selection module. Based on Selection.js,
 * but modified to be suitable for react and has a couple of bug fixes (doesn't
 * assume buttons have range selections allowed).
 * Input selection module for React.
 */
var ReactInputSelection = {

  hasSelectionCapabilities: function(elem) {
    return elem && (
      (elem.nodeName === 'INPUT' && elem.type === 'text') ||
      elem.nodeName === 'TEXTAREA' ||
      elem.contentEditable === 'true'
    );
  },

  getSelectionInformation: function() {
    var focusedElem = getActiveElement();
    return {
      focusedElem: focusedElem,
      selectionRange:
          ReactInputSelection.hasSelectionCapabilities(focusedElem) ?
          ReactInputSelection.getSelection(focusedElem) :
          null
    };
  },

  /**
   * @restoreSelection: If any selection information was potentially lost,
   * restore it. This is useful when performing operations that could remove dom
   * nodes and place them back in, resulting in focus being lost.
   */
  restoreSelection: function(priorSelectionInformation) {
    var curFocusedElem = getActiveElement();
    var priorFocusedElem = priorSelectionInformation.focusedElem;
    var priorSelectionRange = priorSelectionInformation.selectionRange;
    if (curFocusedElem !== priorFocusedElem &&
        isInDocument(priorFocusedElem)) {
      if (ReactInputSelection.hasSelectionCapabilities(priorFocusedElem)) {
        ReactInputSelection.setSelection(
          priorFocusedElem,
          priorSelectionRange
        );
      }
      focusNode(priorFocusedElem);
    }
  },

  /**
   * @getSelection: Gets the selection bounds of a focused textarea, input or
   * contentEditable node.
   * -@input: Look up selection bounds of this input
   * -@return {start: selectionStart, end: selectionEnd}
   */
  getSelection: function(input) {
    var selection;

    if ('selectionStart' in input) {
      // Modern browser with input or textarea.
      selection = {
        start: input.selectionStart,
        end: input.selectionEnd
      };
    } else if (document.selection && input.nodeName === 'INPUT') {
      // IE8 input.
      var range = document.selection.createRange();
      // There can only be one selection per document in IE, so it must
      // be in our element.
      if (range.parentElement() === input) {
        selection = {
          start: -range.moveStart('character', -input.value.length),
          end: -range.moveEnd('character', -input.value.length)
        };
      }
    } else {
      // Content editable or old IE textarea.
      selection = ReactDOMSelection.getOffsets(input);
    }

    return selection || {start: 0, end: 0};
  },

  /**
   * @setSelection: Sets the selection bounds of a textarea or input and focuses
   * the input.
   * -@input     Set selection bounds of this input or textarea
   * -@offsets   Object of same form that is returned from get*
   */
  setSelection: function(input, offsets) {
    var start = offsets.start;
    var end = offsets.end;
    if (typeof end === 'undefined') {
      end = start;
    }

    if ('selectionStart' in input) {
      input.selectionStart = start;
      input.selectionEnd = Math.min(end, input.value.length);
    } else if (document.selection && input.nodeName === 'INPUT') {
      var range = input.createTextRange();
      range.collapse(true);
      range.moveStart('character', start);
      range.moveEnd('character', end - start);
      range.select();
    } else {
      ReactDOMSelection.setOffsets(input, offsets);
    }
  }
};

module.exports = ReactInputSelection;

},{"./ReactDOMSelection":46,"./containsNode":101,"./focusNode":111,"./getActiveElement":113}],60:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactInstanceHandles
 * @typechecks static-only
 */

"use strict";

var ReactRootIndex = require("./ReactRootIndex");

var invariant = require("./invariant");

var SEPARATOR = '.';
var SEPARATOR_LENGTH = SEPARATOR.length;

/**
 * Maximum depth of traversals before we consider the possibility of a bad ID.
 */
var MAX_TREE_DEPTH = 100;

/**
 * Creates a DOM ID prefix to use when mounting React components.
 *
 * @param {number} index A unique integer
 * @return {string} React root ID.
 * @internal
 */
function getReactRootIDString(index) {
  return SEPARATOR + index.toString(36);
}

/**
 * Checks if a character in the supplied ID is a separator or the end.
 *
 * @param {string} id A React DOM ID.
 * @param {number} index Index of the character to check.
 * @return {boolean} True if the character is a separator or end of the ID.
 * @private
 */
function isBoundary(id, index) {
  return id.charAt(index) === SEPARATOR || index === id.length;
}

/**
 * Checks if the supplied string is a valid React DOM ID.
 *
 * @param {string} id A React DOM ID, maybe.
 * @return {boolean} True if the string is a valid React DOM ID.
 * @private
 */
function isValidID(id) {
  return id === '' || (
    id.charAt(0) === SEPARATOR && id.charAt(id.length - 1) !== SEPARATOR
  );
}

/**
 * Checks if the first ID is an ancestor of or equal to the second ID.
 *
 * @param {string} ancestorID
 * @param {string} descendantID
 * @return {boolean} True if `ancestorID` is an ancestor of `descendantID`.
 * @internal
 */
function isAncestorIDOf(ancestorID, descendantID) {
  return (
    descendantID.indexOf(ancestorID) === 0 &&
    isBoundary(descendantID, ancestorID.length)
  );
}

/**
 * Gets the parent ID of the supplied React DOM ID, `id`.
 *
 * @param {string} id ID of a component.
 * @return {string} ID of the parent, or an empty string.
 * @private
 */
function getParentID(id) {
  return id ? id.substr(0, id.lastIndexOf(SEPARATOR)) : '';
}

/**
 * Gets the next DOM ID on the tree path from the supplied `ancestorID` to the
 * supplied `destinationID`. If they are equal, the ID is returned.
 *
 * @param {string} ancestorID ID of an ancestor node of `destinationID`.
 * @param {string} destinationID ID of the destination node.
 * @return {string} Next ID on the path from `ancestorID` to `destinationID`.
 * @private
 */
function getNextDescendantID(ancestorID, destinationID) {
  ("production" !== process.env.NODE_ENV ? invariant(
    isValidID(ancestorID) && isValidID(destinationID),
    'getNextDescendantID(%s, %s): Received an invalid React DOM ID.',
    ancestorID,
    destinationID
  ) : invariant(isValidID(ancestorID) && isValidID(destinationID)));
  ("production" !== process.env.NODE_ENV ? invariant(
    isAncestorIDOf(ancestorID, destinationID),
    'getNextDescendantID(...): React has made an invalid assumption about ' +
    'the DOM hierarchy. Expected `%s` to be an ancestor of `%s`.',
    ancestorID,
    destinationID
  ) : invariant(isAncestorIDOf(ancestorID, destinationID)));
  if (ancestorID === destinationID) {
    return ancestorID;
  }
  // Skip over the ancestor and the immediate separator. Traverse until we hit
  // another separator or we reach the end of `destinationID`.
  var start = ancestorID.length + SEPARATOR_LENGTH;
  for (var i = start; i < destinationID.length; i++) {
    if (isBoundary(destinationID, i)) {
      break;
    }
  }
  return destinationID.substr(0, i);
}

/**
 * Gets the nearest common ancestor ID of two IDs.
 *
 * Using this ID scheme, the nearest common ancestor ID is the longest common
 * prefix of the two IDs that immediately preceded a "marker" in both strings.
 *
 * @param {string} oneID
 * @param {string} twoID
 * @return {string} Nearest common ancestor ID, or the empty string if none.
 * @private
 */
function getFirstCommonAncestorID(oneID, twoID) {
  var minLength = Math.min(oneID.length, twoID.length);
  if (minLength === 0) {
    return '';
  }
  var lastCommonMarkerIndex = 0;
  // Use `<=` to traverse until the "EOL" of the shorter string.
  for (var i = 0; i <= minLength; i++) {
    if (isBoundary(oneID, i) && isBoundary(twoID, i)) {
      lastCommonMarkerIndex = i;
    } else if (oneID.charAt(i) !== twoID.charAt(i)) {
      break;
    }
  }
  var longestCommonID = oneID.substr(0, lastCommonMarkerIndex);
  ("production" !== process.env.NODE_ENV ? invariant(
    isValidID(longestCommonID),
    'getFirstCommonAncestorID(%s, %s): Expected a valid React DOM ID: %s',
    oneID,
    twoID,
    longestCommonID
  ) : invariant(isValidID(longestCommonID)));
  return longestCommonID;
}

/**
 * Traverses the parent path between two IDs (either up or down). The IDs must
 * not be the same, and there must exist a parent path between them. If the
 * callback returns `false`, traversal is stopped.
 *
 * @param {?string} start ID at which to start traversal.
 * @param {?string} stop ID at which to end traversal.
 * @param {function} cb Callback to invoke each ID with.
 * @param {?boolean} skipFirst Whether or not to skip the first node.
 * @param {?boolean} skipLast Whether or not to skip the last node.
 * @private
 */
function traverseParentPath(start, stop, cb, arg, skipFirst, skipLast) {
  start = start || '';
  stop = stop || '';
  ("production" !== process.env.NODE_ENV ? invariant(
    start !== stop,
    'traverseParentPath(...): Cannot traverse from and to the same ID, `%s`.',
    start
  ) : invariant(start !== stop));
  var traverseUp = isAncestorIDOf(stop, start);
  ("production" !== process.env.NODE_ENV ? invariant(
    traverseUp || isAncestorIDOf(start, stop),
    'traverseParentPath(%s, %s, ...): Cannot traverse from two IDs that do ' +
    'not have a parent path.',
    start,
    stop
  ) : invariant(traverseUp || isAncestorIDOf(start, stop)));
  // Traverse from `start` to `stop` one depth at a time.
  var depth = 0;
  var traverse = traverseUp ? getParentID : getNextDescendantID;
  for (var id = start; /* until break */; id = traverse(id, stop)) {
    var ret;
    if ((!skipFirst || id !== start) && (!skipLast || id !== stop)) {
      ret = cb(id, traverseUp, arg);
    }
    if (ret === false || id === stop) {
      // Only break //after// visiting `stop`.
      break;
    }
    ("production" !== process.env.NODE_ENV ? invariant(
      depth++ < MAX_TREE_DEPTH,
      'traverseParentPath(%s, %s, ...): Detected an infinite loop while ' +
      'traversing the React DOM ID tree. This may be due to malformed IDs: %s',
      start, stop
    ) : invariant(depth++ < MAX_TREE_DEPTH));
  }
}

/**
 * Manages the IDs assigned to DOM representations of React components. This
 * uses a specific scheme in order to traverse the DOM efficiently (e.g. in
 * order to simulate events).
 *
 * @internal
 */
var ReactInstanceHandles = {

  /**
   * Constructs a React root ID
   * @return {string} A React root ID.
   */
  createReactRootID: function() {
    return getReactRootIDString(ReactRootIndex.createReactRootIndex());
  },

  /**
   * Constructs a React ID by joining a root ID with a name.
   *
   * @param {string} rootID Root ID of a parent component.
   * @param {string} name A component's name (as flattened children).
   * @return {string} A React ID.
   * @internal
   */
  createReactID: function(rootID, name) {
    return rootID + name;
  },

  /**
   * Gets the DOM ID of the React component that is the root of the tree that
   * contains the React component with the supplied DOM ID.
   *
   * @param {string} id DOM ID of a React component.
   * @return {?string} DOM ID of the React component that is the root.
   * @internal
   */
  getReactRootIDFromNodeID: function(id) {
    if (id && id.charAt(0) === SEPARATOR && id.length > 1) {
      var index = id.indexOf(SEPARATOR, 1);
      return index > -1 ? id.substr(0, index) : id;
    }
    return null;
  },

  /**
   * Traverses the ID hierarchy and invokes the supplied `cb` on any IDs that
   * should would receive a `mouseEnter` or `mouseLeave` event.
   *
   * NOTE: Does not invoke the callback on the nearest common ancestor because
   * nothing "entered" or "left" that element.
   *
   * @param {string} leaveID ID being left.
   * @param {string} enterID ID being entered.
   * @param {function} cb Callback to invoke on each entered/left ID.
   * @param {*} upArg Argument to invoke the callback with on left IDs.
   * @param {*} downArg Argument to invoke the callback with on entered IDs.
   * @internal
   */
  traverseEnterLeave: function(leaveID, enterID, cb, upArg, downArg) {
    var ancestorID = getFirstCommonAncestorID(leaveID, enterID);
    if (ancestorID !== leaveID) {
      traverseParentPath(leaveID, ancestorID, cb, upArg, false, true);
    }
    if (ancestorID !== enterID) {
      traverseParentPath(ancestorID, enterID, cb, downArg, true, false);
    }
  },

  /**
   * Simulates the traversal of a two-phase, capture/bubble event dispatch.
   *
   * NOTE: This traversal happens on IDs without touching the DOM.
   *
   * @param {string} targetID ID of the target node.
   * @param {function} cb Callback to invoke.
   * @param {*} arg Argument to invoke the callback with.
   * @internal
   */
  traverseTwoPhase: function(targetID, cb, arg) {
    if (targetID) {
      traverseParentPath('', targetID, cb, arg, true, false);
      traverseParentPath(targetID, '', cb, arg, false, true);
    }
  },

  /**
   * Traverse a node ID, calling the supplied `cb` for each ancestor ID. For
   * example, passing `.0.$row-0.1` would result in `cb` getting called
   * with `.0`, `.0.$row-0`, and `.0.$row-0.1`.
   *
   * NOTE: This traversal happens on IDs without touching the DOM.
   *
   * @param {string} targetID ID of the target node.
   * @param {function} cb Callback to invoke.
   * @param {*} arg Argument to invoke the callback with.
   * @internal
   */
  traverseAncestors: function(targetID, cb, arg) {
    traverseParentPath('', targetID, cb, arg, true, false);
  },

  /**
   * Exposed for unit testing.
   * @private
   */
  _getFirstCommonAncestorID: getFirstCommonAncestorID,

  /**
   * Exposed for unit testing.
   * @private
   */
  _getNextDescendantID: getNextDescendantID,

  isAncestorIDOf: isAncestorIDOf,

  SEPARATOR: SEPARATOR

};

module.exports = ReactInstanceHandles;

}).call(this,require('_process'))
},{"./ReactRootIndex":75,"./invariant":126,"_process":152}],61:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactLegacyElement
 */

"use strict";

var ReactCurrentOwner = require("./ReactCurrentOwner");

var invariant = require("./invariant");
var monitorCodeUse = require("./monitorCodeUse");
var warning = require("./warning");

var legacyFactoryLogs = {};
function warnForLegacyFactoryCall() {
  if (!ReactLegacyElementFactory._isLegacyCallWarningEnabled) {
    return;
  }
  var owner = ReactCurrentOwner.current;
  var name = owner && owner.constructor ? owner.constructor.displayName : '';
  if (!name) {
    name = 'Something';
  }
  if (legacyFactoryLogs.hasOwnProperty(name)) {
    return;
  }
  legacyFactoryLogs[name] = true;
  ("production" !== process.env.NODE_ENV ? warning(
    false,
    name + ' is calling a React component directly. ' +
    'Use a factory or JSX instead. See: http://fb.me/react-legacyfactory'
  ) : null);
  monitorCodeUse('react_legacy_factory_call', { version: 3, name: name });
}

function warnForPlainFunctionType(type) {
  var isReactClass =
    type.prototype &&
    typeof type.prototype.mountComponent === 'function' &&
    typeof type.prototype.receiveComponent === 'function';
  if (isReactClass) {
    ("production" !== process.env.NODE_ENV ? warning(
      false,
      'Did not expect to get a React class here. Use `Component` instead ' +
      'of `Component.type` or `this.constructor`.'
    ) : null);
  } else {
    if (!type._reactWarnedForThisType) {
      try {
        type._reactWarnedForThisType = true;
      } catch (x) {
        // just incase this is a frozen object or some special object
      }
      monitorCodeUse(
        'react_non_component_in_jsx',
        { version: 3, name: type.name }
      );
    }
    ("production" !== process.env.NODE_ENV ? warning(
      false,
      'This JSX uses a plain function. Only React components are ' +
      'valid in React\'s JSX transform.'
    ) : null);
  }
}

function warnForNonLegacyFactory(type) {
  ("production" !== process.env.NODE_ENV ? warning(
    false,
    'Do not pass React.DOM.' + type.type + ' to JSX or createFactory. ' +
    'Use the string "' + type.type + '" instead.'
  ) : null);
}

/**
 * Transfer static properties from the source to the target. Functions are
 * rebound to have this reflect the original source.
 */
function proxyStaticMethods(target, source) {
  if (typeof source !== 'function') {
    return;
  }
  for (var key in source) {
    if (source.hasOwnProperty(key)) {
      var value = source[key];
      if (typeof value === 'function') {
        var bound = value.bind(source);
        // Copy any properties defined on the function, such as `isRequired` on
        // a PropTypes validator.
        for (var k in value) {
          if (value.hasOwnProperty(k)) {
            bound[k] = value[k];
          }
        }
        target[key] = bound;
      } else {
        target[key] = value;
      }
    }
  }
}

// We use an object instead of a boolean because booleans are ignored by our
// mocking libraries when these factories gets mocked.
var LEGACY_MARKER = {};
var NON_LEGACY_MARKER = {};

var ReactLegacyElementFactory = {};

ReactLegacyElementFactory.wrapCreateFactory = function(createFactory) {
  var legacyCreateFactory = function(type) {
    if (typeof type !== 'function') {
      // Non-function types cannot be legacy factories
      return createFactory(type);
    }

    if (type.isReactNonLegacyFactory) {
      // This is probably a factory created by ReactDOM we unwrap it to get to
      // the underlying string type. It shouldn't have been passed here so we
      // warn.
      if ("production" !== process.env.NODE_ENV) {
        warnForNonLegacyFactory(type);
      }
      return createFactory(type.type);
    }

    if (type.isReactLegacyFactory) {
      // This is probably a legacy factory created by ReactCompositeComponent.
      // We unwrap it to get to the underlying class.
      return createFactory(type.type);
    }

    if ("production" !== process.env.NODE_ENV) {
      warnForPlainFunctionType(type);
    }

    // Unless it's a legacy factory, then this is probably a plain function,
    // that is expecting to be invoked by JSX. We can just return it as is.
    return type;
  };
  return legacyCreateFactory;
};

ReactLegacyElementFactory.wrapCreateElement = function(createElement) {
  var legacyCreateElement = function(type, props, children) {
    if (typeof type !== 'function') {
      // Non-function types cannot be legacy factories
      return createElement.apply(this, arguments);
    }

    var args;

    if (type.isReactNonLegacyFactory) {
      // This is probably a factory created by ReactDOM we unwrap it to get to
      // the underlying string type. It shouldn't have been passed here so we
      // warn.
      if ("production" !== process.env.NODE_ENV) {
        warnForNonLegacyFactory(type);
      }
      args = Array.prototype.slice.call(arguments, 0);
      args[0] = type.type;
      return createElement.apply(this, args);
    }

    if (type.isReactLegacyFactory) {
      // This is probably a legacy factory created by ReactCompositeComponent.
      // We unwrap it to get to the underlying class.
      if (type._isMockFunction) {
        // If this is a mock function, people will expect it to be called. We
        // will actually call the original mock factory function instead. This
        // future proofs unit testing that assume that these are classes.
        type.type._mockedReactClassConstructor = type;
      }
      args = Array.prototype.slice.call(arguments, 0);
      args[0] = type.type;
      return createElement.apply(this, args);
    }

    if ("production" !== process.env.NODE_ENV) {
      warnForPlainFunctionType(type);
    }

    // This is being called with a plain function we should invoke it
    // immediately as if this was used with legacy JSX.
    return type.apply(null, Array.prototype.slice.call(arguments, 1));
  };
  return legacyCreateElement;
};

ReactLegacyElementFactory.wrapFactory = function(factory) {
  ("production" !== process.env.NODE_ENV ? invariant(
    typeof factory === 'function',
    'This is suppose to accept a element factory'
  ) : invariant(typeof factory === 'function'));
  var legacyElementFactory = function(config, children) {
    // This factory should not be called when JSX is used. Use JSX instead.
    if ("production" !== process.env.NODE_ENV) {
      warnForLegacyFactoryCall();
    }
    return factory.apply(this, arguments);
  };
  proxyStaticMethods(legacyElementFactory, factory.type);
  legacyElementFactory.isReactLegacyFactory = LEGACY_MARKER;
  legacyElementFactory.type = factory.type;
  return legacyElementFactory;
};

// This is used to mark a factory that will remain. E.g. we're allowed to call
// it as a function. However, you're not suppose to pass it to createElement
// or createFactory, so it will warn you if you do.
ReactLegacyElementFactory.markNonLegacyFactory = function(factory) {
  factory.isReactNonLegacyFactory = NON_LEGACY_MARKER;
  return factory;
};

// Checks if a factory function is actually a legacy factory pretending to
// be a class.
ReactLegacyElementFactory.isValidFactory = function(factory) {
  // TODO: This will be removed and moved into a class validator or something.
  return typeof factory === 'function' &&
    factory.isReactLegacyFactory === LEGACY_MARKER;
};

ReactLegacyElementFactory.isValidClass = function(factory) {
  if ("production" !== process.env.NODE_ENV) {
    ("production" !== process.env.NODE_ENV ? warning(
      false,
      'isValidClass is deprecated and will be removed in a future release. ' +
      'Use a more specific validator instead.'
    ) : null);
  }
  return ReactLegacyElementFactory.isValidFactory(factory);
};

ReactLegacyElementFactory._isLegacyCallWarningEnabled = true;

module.exports = ReactLegacyElementFactory;

}).call(this,require('_process'))
},{"./ReactCurrentOwner":36,"./invariant":126,"./monitorCodeUse":136,"./warning":145,"_process":152}],62:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactMarkupChecksum
 */

"use strict";

var adler32 = require("./adler32");

var ReactMarkupChecksum = {
  CHECKSUM_ATTR_NAME: 'data-react-checksum',

  /**
   * @param {string} markup Markup string
   * @return {string} Markup string with checksum attribute attached
   */
  addChecksumToMarkup: function(markup) {
    var checksum = adler32(markup);
    return markup.replace(
      '>',
      ' ' + ReactMarkupChecksum.CHECKSUM_ATTR_NAME + '="' + checksum + '">'
    );
  },

  /**
   * @param {string} markup to use
   * @param {DOMElement} element root React element
   * @returns {boolean} whether or not the markup is the same
   */
  canReuseMarkup: function(markup, element) {
    var existingChecksum = element.getAttribute(
      ReactMarkupChecksum.CHECKSUM_ATTR_NAME
    );
    existingChecksum = existingChecksum && parseInt(existingChecksum, 10);
    var markupChecksum = adler32(markup);
    return markupChecksum === existingChecksum;
  }
};

module.exports = ReactMarkupChecksum;

},{"./adler32":98}],63:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactMount
 */

"use strict";

var DOMProperty = require("./DOMProperty");
var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");
var ReactCurrentOwner = require("./ReactCurrentOwner");
var ReactElement = require("./ReactElement");
var ReactLegacyElement = require("./ReactLegacyElement");
var ReactInstanceHandles = require("./ReactInstanceHandles");
var ReactPerf = require("./ReactPerf");

var containsNode = require("./containsNode");
var deprecated = require("./deprecated");
var getReactRootElementInContainer = require("./getReactRootElementInContainer");
var instantiateReactComponent = require("./instantiateReactComponent");
var invariant = require("./invariant");
var shouldUpdateReactComponent = require("./shouldUpdateReactComponent");
var warning = require("./warning");

var createElement = ReactLegacyElement.wrapCreateElement(
  ReactElement.createElement
);

var SEPARATOR = ReactInstanceHandles.SEPARATOR;

var ATTR_NAME = DOMProperty.ID_ATTRIBUTE_NAME;
var nodeCache = {};

var ELEMENT_NODE_TYPE = 1;
var DOC_NODE_TYPE = 9;

/** Mapping from reactRootID to React component instance. */
var instancesByReactRootID = {};

/** Mapping from reactRootID to `container` nodes. */
var containersByReactRootID = {};

if ("production" !== process.env.NODE_ENV) {
  /** __DEV__-only mapping from reactRootID to root elements. */
  var rootElementsByReactRootID = {};
}

// Used to store breadth-first search state in findComponentRoot.
var findComponentRootReusableArray = [];

/**
 * @param {DOMElement} container DOM element that may contain a React component.
 * @return {?string} A "reactRoot" ID, if a React component is rendered.
 */
function getReactRootID(container) {
  var rootElement = getReactRootElementInContainer(container);
  return rootElement && ReactMount.getID(rootElement);
}

/**
 * Accessing node[ATTR_NAME] or calling getAttribute(ATTR_NAME) on a form
 * element can return its control whose name or ID equals ATTR_NAME. All
 * DOM nodes support `getAttributeNode` but this can also get called on
 * other objects so just return '' if we're given something other than a
 * DOM node (such as window).
 *
 * @param {?DOMElement|DOMWindow|DOMDocument|DOMTextNode} node DOM node.
 * @return {string} ID of the supplied `domNode`.
 */
function getID(node) {
  var id = internalGetID(node);
  if (id) {
    if (nodeCache.hasOwnProperty(id)) {
      var cached = nodeCache[id];
      if (cached !== node) {
        ("production" !== process.env.NODE_ENV ? invariant(
          !isValid(cached, id),
          'ReactMount: Two valid but unequal nodes with the same `%s`: %s',
          ATTR_NAME, id
        ) : invariant(!isValid(cached, id)));

        nodeCache[id] = node;
      }
    } else {
      nodeCache[id] = node;
    }
  }

  return id;
}

function internalGetID(node) {
  // If node is something like a window, document, or text node, none of
  // which support attributes or a .getAttribute method, gracefully return
  // the empty string, as if the attribute were missing.
  return node && node.getAttribute && node.getAttribute(ATTR_NAME) || '';
}

/**
 * Sets the React-specific ID of the given node.
 *
 * @param {DOMElement} node The DOM node whose ID will be set.
 * @param {string} id The value of the ID attribute.
 */
function setID(node, id) {
  var oldID = internalGetID(node);
  if (oldID !== id) {
    delete nodeCache[oldID];
  }
  node.setAttribute(ATTR_NAME, id);
  nodeCache[id] = node;
}

/**
 * Finds the node with the supplied React-generated DOM ID.
 *
 * @param {string} id A React-generated DOM ID.
 * @return {DOMElement} DOM node with the suppled `id`.
 * @internal
 */
function getNode(id) {
  if (!nodeCache.hasOwnProperty(id) || !isValid(nodeCache[id], id)) {
    nodeCache[id] = ReactMount.findReactNodeByID(id);
  }
  return nodeCache[id];
}

/**
 * A node is "valid" if it is contained by a currently mounted container.
 *
 * This means that the node does not have to be contained by a document in
 * order to be considered valid.
 *
 * @param {?DOMElement} node The candidate DOM node.
 * @param {string} id The expected ID of the node.
 * @return {boolean} Whether the node is contained by a mounted container.
 */
function isValid(node, id) {
  if (node) {
    ("production" !== process.env.NODE_ENV ? invariant(
      internalGetID(node) === id,
      'ReactMount: Unexpected modification of `%s`',
      ATTR_NAME
    ) : invariant(internalGetID(node) === id));

    var container = ReactMount.findReactContainerForID(id);
    if (container && containsNode(container, node)) {
      return true;
    }
  }

  return false;
}

/**
 * Causes the cache to forget about one React-specific ID.
 *
 * @param {string} id The ID to forget.
 */
function purgeID(id) {
  delete nodeCache[id];
}

var deepestNodeSoFar = null;
function findDeepestCachedAncestorImpl(ancestorID) {
  var ancestor = nodeCache[ancestorID];
  if (ancestor && isValid(ancestor, ancestorID)) {
    deepestNodeSoFar = ancestor;
  } else {
    // This node isn't populated in the cache, so presumably none of its
    // descendants are. Break out of the loop.
    return false;
  }
}

/**
 * Return the deepest cached node whose ID is a prefix of `targetID`.
 */
function findDeepestCachedAncestor(targetID) {
  deepestNodeSoFar = null;
  ReactInstanceHandles.traverseAncestors(
    targetID,
    findDeepestCachedAncestorImpl
  );

  var foundNode = deepestNodeSoFar;
  deepestNodeSoFar = null;
  return foundNode;
}

/**
 * Mounting is the process of initializing a React component by creatings its
 * representative DOM elements and inserting them into a supplied `container`.
 * Any prior content inside `container` is destroyed in the process.
 *
 *   ReactMount.render(
 *     component,
 *     document.getElementById('container')
 *   );
 *
 *   <div id="container">                   <-- Supplied `container`.
 *     <div data-reactid=".3">              <-- Rendered reactRoot of React
 *       // ...                                 component.
 *     </div>
 *   </div>
 *
 * Inside of `container`, the first element rendered is the "reactRoot".
 */
var ReactMount = {
  /** Exposed for debugging purposes **/
  _instancesByReactRootID: instancesByReactRootID,

  /**
   * This is a hook provided to support rendering React components while
   * ensuring that the apparent scroll position of its `container` does not
   * change.
   *
   * @param {DOMElement} container The `container` being rendered into.
   * @param {function} renderCallback This must be called once to do the render.
   */
  scrollMonitor: function(container, renderCallback) {
    renderCallback();
  },

  /**
   * Take a component that's already mounted into the DOM and replace its props
   * @param {ReactComponent} prevComponent component instance already in the DOM
   * @param {ReactComponent} nextComponent component instance to render
   * @param {DOMElement} container container to render into
   * @param {?function} callback function triggered on completion
   */
  _updateRootComponent: function(
      prevComponent,
      nextComponent,
      container,
      callback) {
    var nextProps = nextComponent.props;
    ReactMount.scrollMonitor(container, function() {
      prevComponent.replaceProps(nextProps, callback);
    });

    if ("production" !== process.env.NODE_ENV) {
      // Record the root element in case it later gets transplanted.
      rootElementsByReactRootID[getReactRootID(container)] =
        getReactRootElementInContainer(container);
    }

    return prevComponent;
  },

  /**
   * Register a component into the instance map and starts scroll value
   * monitoring
   * @param {ReactComponent} nextComponent component instance to render
   * @param {DOMElement} container container to render into
   * @return {string} reactRoot ID prefix
   */
  _registerComponent: function(nextComponent, container) {
    ("production" !== process.env.NODE_ENV ? invariant(
      container && (
        container.nodeType === ELEMENT_NODE_TYPE ||
        container.nodeType === DOC_NODE_TYPE
      ),
      '_registerComponent(...): Target container is not a DOM element.'
    ) : invariant(container && (
      container.nodeType === ELEMENT_NODE_TYPE ||
      container.nodeType === DOC_NODE_TYPE
    )));

    ReactBrowserEventEmitter.ensureScrollValueMonitoring();

    var reactRootID = ReactMount.registerContainer(container);
    instancesByReactRootID[reactRootID] = nextComponent;
    return reactRootID;
  },

  /**
   * Render a new component into the DOM.
   * @param {ReactComponent} nextComponent component instance to render
   * @param {DOMElement} container container to render into
   * @param {boolean} shouldReuseMarkup if we should skip the markup insertion
   * @return {ReactComponent} nextComponent
   */
  _renderNewRootComponent: ReactPerf.measure(
    'ReactMount',
    '_renderNewRootComponent',
    function(
        nextComponent,
        container,
        shouldReuseMarkup) {
      // Various parts of our code (such as ReactCompositeComponent's
      // _renderValidatedComponent) assume that calls to render aren't nested;
      // verify that that's the case.
      ("production" !== process.env.NODE_ENV ? warning(
        ReactCurrentOwner.current == null,
        '_renderNewRootComponent(): Render methods should be a pure function ' +
        'of props and state; triggering nested component updates from ' +
        'render is not allowed. If necessary, trigger nested updates in ' +
        'componentDidUpdate.'
      ) : null);

      var componentInstance = instantiateReactComponent(nextComponent, null);
      var reactRootID = ReactMount._registerComponent(
        componentInstance,
        container
      );
      componentInstance.mountComponentIntoNode(
        reactRootID,
        container,
        shouldReuseMarkup
      );

      if ("production" !== process.env.NODE_ENV) {
        // Record the root element in case it later gets transplanted.
        rootElementsByReactRootID[reactRootID] =
          getReactRootElementInContainer(container);
      }

      return componentInstance;
    }
  ),

  /**
   * Renders a React component into the DOM in the supplied `container`.
   *
   * If the React component was previously rendered into `container`, this will
   * perform an update on it and only mutate the DOM as necessary to reflect the
   * latest React component.
   *
   * @param {ReactElement} nextElement Component element to render.
   * @param {DOMElement} container DOM element to render into.
   * @param {?function} callback function triggered on completion
   * @return {ReactComponent} Component instance rendered in `container`.
   */
  render: function(nextElement, container, callback) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ReactElement.isValidElement(nextElement),
      'renderComponent(): Invalid component element.%s',
      (
        typeof nextElement === 'string' ?
          ' Instead of passing an element string, make sure to instantiate ' +
          'it by passing it to React.createElement.' :
        ReactLegacyElement.isValidFactory(nextElement) ?
          ' Instead of passing a component class, make sure to instantiate ' +
          'it by passing it to React.createElement.' :
        // Check if it quacks like a element
        typeof nextElement.props !== "undefined" ?
          ' This may be caused by unintentionally loading two independent ' +
          'copies of React.' :
          ''
      )
    ) : invariant(ReactElement.isValidElement(nextElement)));

    var prevComponent = instancesByReactRootID[getReactRootID(container)];

    if (prevComponent) {
      var prevElement = prevComponent._currentElement;
      if (shouldUpdateReactComponent(prevElement, nextElement)) {
        return ReactMount._updateRootComponent(
          prevComponent,
          nextElement,
          container,
          callback
        );
      } else {
        ReactMount.unmountComponentAtNode(container);
      }
    }

    var reactRootElement = getReactRootElementInContainer(container);
    var containerHasReactMarkup =
      reactRootElement && ReactMount.isRenderedByReact(reactRootElement);

    var shouldReuseMarkup = containerHasReactMarkup && !prevComponent;

    var component = ReactMount._renderNewRootComponent(
      nextElement,
      container,
      shouldReuseMarkup
    );
    callback && callback.call(component);
    return component;
  },

  /**
   * Constructs a component instance of `constructor` with `initialProps` and
   * renders it into the supplied `container`.
   *
   * @param {function} constructor React component constructor.
   * @param {?object} props Initial props of the component instance.
   * @param {DOMElement} container DOM element to render into.
   * @return {ReactComponent} Component instance rendered in `container`.
   */
  constructAndRenderComponent: function(constructor, props, container) {
    var element = createElement(constructor, props);
    return ReactMount.render(element, container);
  },

  /**
   * Constructs a component instance of `constructor` with `initialProps` and
   * renders it into a container node identified by supplied `id`.
   *
   * @param {function} componentConstructor React component constructor
   * @param {?object} props Initial props of the component instance.
   * @param {string} id ID of the DOM element to render into.
   * @return {ReactComponent} Component instance rendered in the container node.
   */
  constructAndRenderComponentByID: function(constructor, props, id) {
    var domNode = document.getElementById(id);
    ("production" !== process.env.NODE_ENV ? invariant(
      domNode,
      'Tried to get element with id of "%s" but it is not present on the page.',
      id
    ) : invariant(domNode));
    return ReactMount.constructAndRenderComponent(constructor, props, domNode);
  },

  /**
   * Registers a container node into which React components will be rendered.
   * This also creates the "reactRoot" ID that will be assigned to the element
   * rendered within.
   *
   * @param {DOMElement} container DOM element to register as a container.
   * @return {string} The "reactRoot" ID of elements rendered within.
   */
  registerContainer: function(container) {
    var reactRootID = getReactRootID(container);
    if (reactRootID) {
      // If one exists, make sure it is a valid "reactRoot" ID.
      reactRootID = ReactInstanceHandles.getReactRootIDFromNodeID(reactRootID);
    }
    if (!reactRootID) {
      // No valid "reactRoot" ID found, create one.
      reactRootID = ReactInstanceHandles.createReactRootID();
    }
    containersByReactRootID[reactRootID] = container;
    return reactRootID;
  },

  /**
   * Unmounts and destroys the React component rendered in the `container`.
   *
   * @param {DOMElement} container DOM element containing a React component.
   * @return {boolean} True if a component was found in and unmounted from
   *                   `container`
   */
  unmountComponentAtNode: function(container) {
    // Various parts of our code (such as ReactCompositeComponent's
    // _renderValidatedComponent) assume that calls to render aren't nested;
    // verify that that's the case. (Strictly speaking, unmounting won't cause a
    // render but we still don't expect to be in a render call here.)
    ("production" !== process.env.NODE_ENV ? warning(
      ReactCurrentOwner.current == null,
      'unmountComponentAtNode(): Render methods should be a pure function of ' +
      'props and state; triggering nested component updates from render is ' +
      'not allowed. If necessary, trigger nested updates in ' +
      'componentDidUpdate.'
    ) : null);

    var reactRootID = getReactRootID(container);
    var component = instancesByReactRootID[reactRootID];
    if (!component) {
      return false;
    }
    ReactMount.unmountComponentFromNode(component, container);
    delete instancesByReactRootID[reactRootID];
    delete containersByReactRootID[reactRootID];
    if ("production" !== process.env.NODE_ENV) {
      delete rootElementsByReactRootID[reactRootID];
    }
    return true;
  },

  /**
   * Unmounts a component and removes it from the DOM.
   *
   * @param {ReactComponent} instance React component instance.
   * @param {DOMElement} container DOM element to unmount from.
   * @final
   * @internal
   * @see {ReactMount.unmountComponentAtNode}
   */
  unmountComponentFromNode: function(instance, container) {
    instance.unmountComponent();

    if (container.nodeType === DOC_NODE_TYPE) {
      container = container.documentElement;
    }

    // http://jsperf.com/emptying-a-node
    while (container.lastChild) {
      container.removeChild(container.lastChild);
    }
  },

  /**
   * Finds the container DOM element that contains React component to which the
   * supplied DOM `id` belongs.
   *
   * @param {string} id The ID of an element rendered by a React component.
   * @return {?DOMElement} DOM element that contains the `id`.
   */
  findReactContainerForID: function(id) {
    var reactRootID = ReactInstanceHandles.getReactRootIDFromNodeID(id);
    var container = containersByReactRootID[reactRootID];

    if ("production" !== process.env.NODE_ENV) {
      var rootElement = rootElementsByReactRootID[reactRootID];
      if (rootElement && rootElement.parentNode !== container) {
        ("production" !== process.env.NODE_ENV ? invariant(
          // Call internalGetID here because getID calls isValid which calls
          // findReactContainerForID (this function).
          internalGetID(rootElement) === reactRootID,
          'ReactMount: Root element ID differed from reactRootID.'
        ) : invariant(// Call internalGetID here because getID calls isValid which calls
        // findReactContainerForID (this function).
        internalGetID(rootElement) === reactRootID));

        var containerChild = container.firstChild;
        if (containerChild &&
            reactRootID === internalGetID(containerChild)) {
          // If the container has a new child with the same ID as the old
          // root element, then rootElementsByReactRootID[reactRootID] is
          // just stale and needs to be updated. The case that deserves a
          // warning is when the container is empty.
          rootElementsByReactRootID[reactRootID] = containerChild;
        } else {
          console.warn(
            'ReactMount: Root element has been removed from its original ' +
            'container. New container:', rootElement.parentNode
          );
        }
      }
    }

    return container;
  },

  /**
   * Finds an element rendered by React with the supplied ID.
   *
   * @param {string} id ID of a DOM node in the React component.
   * @return {DOMElement} Root DOM node of the React component.
   */
  findReactNodeByID: function(id) {
    var reactRoot = ReactMount.findReactContainerForID(id);
    return ReactMount.findComponentRoot(reactRoot, id);
  },

  /**
   * True if the supplied `node` is rendered by React.
   *
   * @param {*} node DOM Element to check.
   * @return {boolean} True if the DOM Element appears to be rendered by React.
   * @internal
   */
  isRenderedByReact: function(node) {
    if (node.nodeType !== 1) {
      // Not a DOMElement, therefore not a React component
      return false;
    }
    var id = ReactMount.getID(node);
    return id ? id.charAt(0) === SEPARATOR : false;
  },

  /**
   * Traverses up the ancestors of the supplied node to find a node that is a
   * DOM representation of a React component.
   *
   * @param {*} node
   * @return {?DOMEventTarget}
   * @internal
   */
  getFirstReactDOM: function(node) {
    var current = node;
    while (current && current.parentNode !== current) {
      if (ReactMount.isRenderedByReact(current)) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  },

  /**
   * Finds a node with the supplied `targetID` inside of the supplied
   * `ancestorNode`.  Exploits the ID naming scheme to perform the search
   * quickly.
   *
   * @param {DOMEventTarget} ancestorNode Search from this root.
   * @pararm {string} targetID ID of the DOM representation of the component.
   * @return {DOMEventTarget} DOM node with the supplied `targetID`.
   * @internal
   */
  findComponentRoot: function(ancestorNode, targetID) {
    var firstChildren = findComponentRootReusableArray;
    var childIndex = 0;

    var deepestAncestor = findDeepestCachedAncestor(targetID) || ancestorNode;

    firstChildren[0] = deepestAncestor.firstChild;
    firstChildren.length = 1;

    while (childIndex < firstChildren.length) {
      var child = firstChildren[childIndex++];
      var targetChild;

      while (child) {
        var childID = ReactMount.getID(child);
        if (childID) {
          // Even if we find the node we're looking for, we finish looping
          // through its siblings to ensure they're cached so that we don't have
          // to revisit this node again. Otherwise, we make n^2 calls to getID
          // when visiting the many children of a single node in order.

          if (targetID === childID) {
            targetChild = child;
          } else if (ReactInstanceHandles.isAncestorIDOf(childID, targetID)) {
            // If we find a child whose ID is an ancestor of the given ID,
            // then we can be sure that we only want to search the subtree
            // rooted at this child, so we can throw out the rest of the
            // search state.
            firstChildren.length = childIndex = 0;
            firstChildren.push(child.firstChild);
          }

        } else {
          // If this child had no ID, then there's a chance that it was
          // injected automatically by the browser, as when a `<table>`
          // element sprouts an extra `<tbody>` child as a side effect of
          // `.innerHTML` parsing. Optimistically continue down this
          // branch, but not before examining the other siblings.
          firstChildren.push(child.firstChild);
        }

        child = child.nextSibling;
      }

      if (targetChild) {
        // Emptying firstChildren/findComponentRootReusableArray is
        // not necessary for correctness, but it helps the GC reclaim
        // any nodes that were left at the end of the search.
        firstChildren.length = 0;

        return targetChild;
      }
    }

    firstChildren.length = 0;

    ("production" !== process.env.NODE_ENV ? invariant(
      false,
      'findComponentRoot(..., %s): Unable to find element. This probably ' +
      'means the DOM was unexpectedly mutated (e.g., by the browser), ' +
      'usually due to forgetting a <tbody> when using tables, nesting tags ' +
      'like <form>, <p>, or <a>, or using non-SVG elements in an <svg> ' +
      'parent. ' +
      'Try inspecting the child nodes of the element with React ID `%s`.',
      targetID,
      ReactMount.getID(ancestorNode)
    ) : invariant(false));
  },


  /**
   * React ID utilities.
   */

  getReactRootID: getReactRootID,

  getID: getID,

  setID: setID,

  getNode: getNode,

  purgeID: purgeID
};

// Deprecations (remove for 0.13)
ReactMount.renderComponent = deprecated(
  'ReactMount',
  'renderComponent',
  'render',
  this,
  ReactMount.render
);

module.exports = ReactMount;

}).call(this,require('_process'))
},{"./DOMProperty":10,"./ReactBrowserEventEmitter":30,"./ReactCurrentOwner":36,"./ReactElement":52,"./ReactInstanceHandles":60,"./ReactLegacyElement":61,"./ReactPerf":68,"./containsNode":101,"./deprecated":106,"./getReactRootElementInContainer":120,"./instantiateReactComponent":125,"./invariant":126,"./shouldUpdateReactComponent":142,"./warning":145,"_process":152}],64:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactMultiChild
 * @typechecks static-only
 */

"use strict";

var ReactComponent = require("./ReactComponent");
var ReactMultiChildUpdateTypes = require("./ReactMultiChildUpdateTypes");

var flattenChildren = require("./flattenChildren");
var instantiateReactComponent = require("./instantiateReactComponent");
var shouldUpdateReactComponent = require("./shouldUpdateReactComponent");

/**
 * Updating children of a component may trigger recursive updates. The depth is
 * used to batch recursive updates to render markup more efficiently.
 *
 * @type {number}
 * @private
 */
var updateDepth = 0;

/**
 * Queue of update configuration objects.
 *
 * Each object has a `type` property that is in `ReactMultiChildUpdateTypes`.
 *
 * @type {array<object>}
 * @private
 */
var updateQueue = [];

/**
 * Queue of markup to be rendered.
 *
 * @type {array<string>}
 * @private
 */
var markupQueue = [];

/**
 * Enqueues markup to be rendered and inserted at a supplied index.
 *
 * @param {string} parentID ID of the parent component.
 * @param {string} markup Markup that renders into an element.
 * @param {number} toIndex Destination index.
 * @private
 */
function enqueueMarkup(parentID, markup, toIndex) {
  // NOTE: Null values reduce hidden classes.
  updateQueue.push({
    parentID: parentID,
    parentNode: null,
    type: ReactMultiChildUpdateTypes.INSERT_MARKUP,
    markupIndex: markupQueue.push(markup) - 1,
    textContent: null,
    fromIndex: null,
    toIndex: toIndex
  });
}

/**
 * Enqueues moving an existing element to another index.
 *
 * @param {string} parentID ID of the parent component.
 * @param {number} fromIndex Source index of the existing element.
 * @param {number} toIndex Destination index of the element.
 * @private
 */
function enqueueMove(parentID, fromIndex, toIndex) {
  // NOTE: Null values reduce hidden classes.
  updateQueue.push({
    parentID: parentID,
    parentNode: null,
    type: ReactMultiChildUpdateTypes.MOVE_EXISTING,
    markupIndex: null,
    textContent: null,
    fromIndex: fromIndex,
    toIndex: toIndex
  });
}

/**
 * Enqueues removing an element at an index.
 *
 * @param {string} parentID ID of the parent component.
 * @param {number} fromIndex Index of the element to remove.
 * @private
 */
function enqueueRemove(parentID, fromIndex) {
  // NOTE: Null values reduce hidden classes.
  updateQueue.push({
    parentID: parentID,
    parentNode: null,
    type: ReactMultiChildUpdateTypes.REMOVE_NODE,
    markupIndex: null,
    textContent: null,
    fromIndex: fromIndex,
    toIndex: null
  });
}

/**
 * Enqueues setting the text content.
 *
 * @param {string} parentID ID of the parent component.
 * @param {string} textContent Text content to set.
 * @private
 */
function enqueueTextContent(parentID, textContent) {
  // NOTE: Null values reduce hidden classes.
  updateQueue.push({
    parentID: parentID,
    parentNode: null,
    type: ReactMultiChildUpdateTypes.TEXT_CONTENT,
    markupIndex: null,
    textContent: textContent,
    fromIndex: null,
    toIndex: null
  });
}

/**
 * Processes any enqueued updates.
 *
 * @private
 */
function processQueue() {
  if (updateQueue.length) {
    ReactComponent.BackendIDOperations.dangerouslyProcessChildrenUpdates(
      updateQueue,
      markupQueue
    );
    clearQueue();
  }
}

/**
 * Clears any enqueued updates.
 *
 * @private
 */
function clearQueue() {
  updateQueue.length = 0;
  markupQueue.length = 0;
}

/**
 * ReactMultiChild are capable of reconciling multiple children.
 *
 * @class ReactMultiChild
 * @internal
 */
var ReactMultiChild = {

  /**
   * Provides common functionality for components that must reconcile multiple
   * children. This is used by `ReactDOMComponent` to mount, update, and
   * unmount child components.
   *
   * @lends {ReactMultiChild.prototype}
   */
  Mixin: {

    /**
     * Generates a "mount image" for each of the supplied children. In the case
     * of `ReactDOMComponent`, a mount image is a string of markup.
     *
     * @param {?object} nestedChildren Nested child maps.
     * @return {array} An array of mounted representations.
     * @internal
     */
    mountChildren: function(nestedChildren, transaction) {
      var children = flattenChildren(nestedChildren);
      var mountImages = [];
      var index = 0;
      this._renderedChildren = children;
      for (var name in children) {
        var child = children[name];
        if (children.hasOwnProperty(name)) {
          // The rendered children must be turned into instances as they're
          // mounted.
          var childInstance = instantiateReactComponent(child, null);
          children[name] = childInstance;
          // Inlined for performance, see `ReactInstanceHandles.createReactID`.
          var rootID = this._rootNodeID + name;
          var mountImage = childInstance.mountComponent(
            rootID,
            transaction,
            this._mountDepth + 1
          );
          childInstance._mountIndex = index;
          mountImages.push(mountImage);
          index++;
        }
      }
      return mountImages;
    },

    /**
     * Replaces any rendered children with a text content string.
     *
     * @param {string} nextContent String of content.
     * @internal
     */
    updateTextContent: function(nextContent) {
      updateDepth++;
      var errorThrown = true;
      try {
        var prevChildren = this._renderedChildren;
        // Remove any rendered children.
        for (var name in prevChildren) {
          if (prevChildren.hasOwnProperty(name)) {
            this._unmountChildByName(prevChildren[name], name);
          }
        }
        // Set new text content.
        this.setTextContent(nextContent);
        errorThrown = false;
      } finally {
        updateDepth--;
        if (!updateDepth) {
          errorThrown ? clearQueue() : processQueue();
        }
      }
    },

    /**
     * Updates the rendered children with new children.
     *
     * @param {?object} nextNestedChildren Nested child maps.
     * @param {ReactReconcileTransaction} transaction
     * @internal
     */
    updateChildren: function(nextNestedChildren, transaction) {
      updateDepth++;
      var errorThrown = true;
      try {
        this._updateChildren(nextNestedChildren, transaction);
        errorThrown = false;
      } finally {
        updateDepth--;
        if (!updateDepth) {
          errorThrown ? clearQueue() : processQueue();
        }
      }
    },

    /**
     * Improve performance by isolating this hot code path from the try/catch
     * block in `updateChildren`.
     *
     * @param {?object} nextNestedChildren Nested child maps.
     * @param {ReactReconcileTransaction} transaction
     * @final
     * @protected
     */
    _updateChildren: function(nextNestedChildren, transaction) {
      var nextChildren = flattenChildren(nextNestedChildren);
      var prevChildren = this._renderedChildren;
      if (!nextChildren && !prevChildren) {
        return;
      }
      var name;
      // `nextIndex` will increment for each child in `nextChildren`, but
      // `lastIndex` will be the last index visited in `prevChildren`.
      var lastIndex = 0;
      var nextIndex = 0;
      for (name in nextChildren) {
        if (!nextChildren.hasOwnProperty(name)) {
          continue;
        }
        var prevChild = prevChildren && prevChildren[name];
        var prevElement = prevChild && prevChild._currentElement;
        var nextElement = nextChildren[name];
        if (shouldUpdateReactComponent(prevElement, nextElement)) {
          this.moveChild(prevChild, nextIndex, lastIndex);
          lastIndex = Math.max(prevChild._mountIndex, lastIndex);
          prevChild.receiveComponent(nextElement, transaction);
          prevChild._mountIndex = nextIndex;
        } else {
          if (prevChild) {
            // Update `lastIndex` before `_mountIndex` gets unset by unmounting.
            lastIndex = Math.max(prevChild._mountIndex, lastIndex);
            this._unmountChildByName(prevChild, name);
          }
          // The child must be instantiated before it's mounted.
          var nextChildInstance = instantiateReactComponent(
            nextElement,
            null
          );
          this._mountChildByNameAtIndex(
            nextChildInstance, name, nextIndex, transaction
          );
        }
        nextIndex++;
      }
      // Remove children that are no longer present.
      for (name in prevChildren) {
        if (prevChildren.hasOwnProperty(name) &&
            !(nextChildren && nextChildren[name])) {
          this._unmountChildByName(prevChildren[name], name);
        }
      }
    },

    /**
     * Unmounts all rendered children. This should be used to clean up children
     * when this component is unmounted.
     *
     * @internal
     */
    unmountChildren: function() {
      var renderedChildren = this._renderedChildren;
      for (var name in renderedChildren) {
        var renderedChild = renderedChildren[name];
        // TODO: When is this not true?
        if (renderedChild.unmountComponent) {
          renderedChild.unmountComponent();
        }
      }
      this._renderedChildren = null;
    },

    /**
     * Moves a child component to the supplied index.
     *
     * @param {ReactComponent} child Component to move.
     * @param {number} toIndex Destination index of the element.
     * @param {number} lastIndex Last index visited of the siblings of `child`.
     * @protected
     */
    moveChild: function(child, toIndex, lastIndex) {
      // If the index of `child` is less than `lastIndex`, then it needs to
      // be moved. Otherwise, we do not need to move it because a child will be
      // inserted or moved before `child`.
      if (child._mountIndex < lastIndex) {
        enqueueMove(this._rootNodeID, child._mountIndex, toIndex);
      }
    },

    /**
     * Creates a child component.
     *
     * @param {ReactComponent} child Component to create.
     * @param {string} mountImage Markup to insert.
     * @protected
     */
    createChild: function(child, mountImage) {
      enqueueMarkup(this._rootNodeID, mountImage, child._mountIndex);
    },

    /**
     * Removes a child component.
     *
     * @param {ReactComponent} child Child to remove.
     * @protected
     */
    removeChild: function(child) {
      enqueueRemove(this._rootNodeID, child._mountIndex);
    },

    /**
     * Sets this text content string.
     *
     * @param {string} textContent Text content to set.
     * @protected
     */
    setTextContent: function(textContent) {
      enqueueTextContent(this._rootNodeID, textContent);
    },

    /**
     * Mounts a child with the supplied name.
     *
     * NOTE: This is part of `updateChildren` and is here for readability.
     *
     * @param {ReactComponent} child Component to mount.
     * @param {string} name Name of the child.
     * @param {number} index Index at which to insert the child.
     * @param {ReactReconcileTransaction} transaction
     * @private
     */
    _mountChildByNameAtIndex: function(child, name, index, transaction) {
      // Inlined for performance, see `ReactInstanceHandles.createReactID`.
      var rootID = this._rootNodeID + name;
      var mountImage = child.mountComponent(
        rootID,
        transaction,
        this._mountDepth + 1
      );
      child._mountIndex = index;
      this.createChild(child, mountImage);
      this._renderedChildren = this._renderedChildren || {};
      this._renderedChildren[name] = child;
    },

    /**
     * Unmounts a rendered child by name.
     *
     * NOTE: This is part of `updateChildren` and is here for readability.
     *
     * @param {ReactComponent} child Component to unmount.
     * @param {string} name Name of the child in `this._renderedChildren`.
     * @private
     */
    _unmountChildByName: function(child, name) {
      this.removeChild(child);
      child._mountIndex = null;
      child.unmountComponent();
      delete this._renderedChildren[name];
    }

  }

};

module.exports = ReactMultiChild;

},{"./ReactComponent":32,"./ReactMultiChildUpdateTypes":65,"./flattenChildren":110,"./instantiateReactComponent":125,"./shouldUpdateReactComponent":142}],65:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactMultiChildUpdateTypes
 */

"use strict";

var keyMirror = require("./keyMirror");

/**
 * When a component's children are updated, a series of update configuration
 * objects are created in order to batch and serialize the required changes.
 *
 * Enumerates all the possible types of update configurations.
 *
 * @internal
 */
var ReactMultiChildUpdateTypes = keyMirror({
  INSERT_MARKUP: null,
  MOVE_EXISTING: null,
  REMOVE_NODE: null,
  TEXT_CONTENT: null
});

module.exports = ReactMultiChildUpdateTypes;

},{"./keyMirror":132}],66:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactNativeComponent
 */

"use strict";

var assign = require("./Object.assign");
var invariant = require("./invariant");

var genericComponentClass = null;
// This registry keeps track of wrapper classes around native tags
var tagToComponentClass = {};

var ReactNativeComponentInjection = {
  // This accepts a class that receives the tag string. This is a catch all
  // that can render any kind of tag.
  injectGenericComponentClass: function(componentClass) {
    genericComponentClass = componentClass;
  },
  // This accepts a keyed object with classes as values. Each key represents a
  // tag. That particular tag will use this class instead of the generic one.
  injectComponentClasses: function(componentClasses) {
    assign(tagToComponentClass, componentClasses);
  }
};

/**
 * Create an internal class for a specific tag.
 *
 * @param {string} tag The tag for which to create an internal instance.
 * @param {any} props The props passed to the instance constructor.
 * @return {ReactComponent} component The injected empty component.
 */
function createInstanceForTag(tag, props, parentType) {
  var componentClass = tagToComponentClass[tag];
  if (componentClass == null) {
    ("production" !== process.env.NODE_ENV ? invariant(
      genericComponentClass,
      'There is no registered component for the tag %s',
      tag
    ) : invariant(genericComponentClass));
    return new genericComponentClass(tag, props);
  }
  if (parentType === tag) {
    // Avoid recursion
    ("production" !== process.env.NODE_ENV ? invariant(
      genericComponentClass,
      'There is no registered component for the tag %s',
      tag
    ) : invariant(genericComponentClass));
    return new genericComponentClass(tag, props);
  }
  // Unwrap legacy factories
  return new componentClass.type(props);
}

var ReactNativeComponent = {
  createInstanceForTag: createInstanceForTag,
  injection: ReactNativeComponentInjection,
};

module.exports = ReactNativeComponent;

}).call(this,require('_process'))
},{"./Object.assign":26,"./invariant":126,"_process":152}],67:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactOwner
 */

"use strict";

var emptyObject = require("./emptyObject");
var invariant = require("./invariant");

/**
 * ReactOwners are capable of storing references to owned components.
 *
 * All components are capable of //being// referenced by owner components, but
 * only ReactOwner components are capable of //referencing// owned components.
 * The named reference is known as a "ref".
 *
 * Refs are available when mounted and updated during reconciliation.
 *
 *   var MyComponent = React.createClass({
 *     render: function() {
 *       return (
 *         <div onClick={this.handleClick}>
 *           <CustomComponent ref="custom" />
 *         </div>
 *       );
 *     },
 *     handleClick: function() {
 *       this.refs.custom.handleClick();
 *     },
 *     componentDidMount: function() {
 *       this.refs.custom.initialize();
 *     }
 *   });
 *
 * Refs should rarely be used. When refs are used, they should only be done to
 * control data that is not handled by React's data flow.
 *
 * @class ReactOwner
 */
var ReactOwner = {

  /**
   * @param {?object} object
   * @return {boolean} True if `object` is a valid owner.
   * @final
   */
  isValidOwner: function(object) {
    return !!(
      object &&
      typeof object.attachRef === 'function' &&
      typeof object.detachRef === 'function'
    );
  },

  /**
   * Adds a component by ref to an owner component.
   *
   * @param {ReactComponent} component Component to reference.
   * @param {string} ref Name by which to refer to the component.
   * @param {ReactOwner} owner Component on which to record the ref.
   * @final
   * @internal
   */
  addComponentAsRefTo: function(component, ref, owner) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ReactOwner.isValidOwner(owner),
      'addComponentAsRefTo(...): Only a ReactOwner can have refs. This ' +
      'usually means that you\'re trying to add a ref to a component that ' +
      'doesn\'t have an owner (that is, was not created inside of another ' +
      'component\'s `render` method). Try rendering this component inside of ' +
      'a new top-level component which will hold the ref.'
    ) : invariant(ReactOwner.isValidOwner(owner)));
    owner.attachRef(ref, component);
  },

  /**
   * Removes a component by ref from an owner component.
   *
   * @param {ReactComponent} component Component to dereference.
   * @param {string} ref Name of the ref to remove.
   * @param {ReactOwner} owner Component on which the ref is recorded.
   * @final
   * @internal
   */
  removeComponentAsRefFrom: function(component, ref, owner) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ReactOwner.isValidOwner(owner),
      'removeComponentAsRefFrom(...): Only a ReactOwner can have refs. This ' +
      'usually means that you\'re trying to remove a ref to a component that ' +
      'doesn\'t have an owner (that is, was not created inside of another ' +
      'component\'s `render` method). Try rendering this component inside of ' +
      'a new top-level component which will hold the ref.'
    ) : invariant(ReactOwner.isValidOwner(owner)));
    // Check that `component` is still the current ref because we do not want to
    // detach the ref if another component stole it.
    if (owner.refs[ref] === component) {
      owner.detachRef(ref);
    }
  },

  /**
   * A ReactComponent must mix this in to have refs.
   *
   * @lends {ReactOwner.prototype}
   */
  Mixin: {

    construct: function() {
      this.refs = emptyObject;
    },

    /**
     * Lazily allocates the refs object and stores `component` as `ref`.
     *
     * @param {string} ref Reference name.
     * @param {component} component Component to store as `ref`.
     * @final
     * @private
     */
    attachRef: function(ref, component) {
      ("production" !== process.env.NODE_ENV ? invariant(
        component.isOwnedBy(this),
        'attachRef(%s, ...): Only a component\'s owner can store a ref to it.',
        ref
      ) : invariant(component.isOwnedBy(this)));
      var refs = this.refs === emptyObject ? (this.refs = {}) : this.refs;
      refs[ref] = component;
    },

    /**
     * Detaches a reference name.
     *
     * @param {string} ref Name to dereference.
     * @final
     * @private
     */
    detachRef: function(ref) {
      delete this.refs[ref];
    }

  }

};

module.exports = ReactOwner;

}).call(this,require('_process'))
},{"./emptyObject":108,"./invariant":126,"_process":152}],68:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPerf
 * @typechecks static-only
 */

"use strict";

/**
 * ReactPerf is a general AOP system designed to measure performance. This
 * module only has the hooks: see ReactDefaultPerf for the analysis tool.
 */
var ReactPerf = {
  /**
   * Boolean to enable/disable measurement. Set to false by default to prevent
   * accidental logging and perf loss.
   */
  enableMeasure: false,

  /**
   * Holds onto the measure function in use. By default, don't measure
   * anything, but we'll override this if we inject a measure function.
   */
  storedMeasure: _noMeasure,

  /**
   * Use this to wrap methods you want to measure. Zero overhead in production.
   *
   * @param {string} objName
   * @param {string} fnName
   * @param {function} func
   * @return {function}
   */
  measure: function(objName, fnName, func) {
    if ("production" !== process.env.NODE_ENV) {
      var measuredFunc = null;
      var wrapper = function() {
        if (ReactPerf.enableMeasure) {
          if (!measuredFunc) {
            measuredFunc = ReactPerf.storedMeasure(objName, fnName, func);
          }
          return measuredFunc.apply(this, arguments);
        }
        return func.apply(this, arguments);
      };
      wrapper.displayName = objName + '_' + fnName;
      return wrapper;
    }
    return func;
  },

  injection: {
    /**
     * @param {function} measure
     */
    injectMeasure: function(measure) {
      ReactPerf.storedMeasure = measure;
    }
  }
};

/**
 * Simply passes through the measured function, without measuring it.
 *
 * @param {string} objName
 * @param {string} fnName
 * @param {function} func
 * @return {function}
 */
function _noMeasure(objName, fnName, func) {
  return func;
}

module.exports = ReactPerf;

}).call(this,require('_process'))
},{"_process":152}],69:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPropTransferer
 */

"use strict";

var assign = require("./Object.assign");
var emptyFunction = require("./emptyFunction");
var invariant = require("./invariant");
var joinClasses = require("./joinClasses");
var warning = require("./warning");

var didWarn = false;

/**
 * Creates a transfer strategy that will merge prop values using the supplied
 * `mergeStrategy`. If a prop was previously unset, this just sets it.
 *
 * @param {function} mergeStrategy
 * @return {function}
 */
function createTransferStrategy(mergeStrategy) {
  return function(props, key, value) {
    if (!props.hasOwnProperty(key)) {
      props[key] = value;
    } else {
      props[key] = mergeStrategy(props[key], value);
    }
  };
}

var transferStrategyMerge = createTransferStrategy(function(a, b) {
  // `merge` overrides the first object's (`props[key]` above) keys using the
  // second object's (`value`) keys. An object's style's existing `propA` would
  // get overridden. Flip the order here.
  return assign({}, b, a);
});

/**
 * Transfer strategies dictate how props are transferred by `transferPropsTo`.
 * NOTE: if you add any more exceptions to this list you should be sure to
 * update `cloneWithProps()` accordingly.
 */
var TransferStrategies = {
  /**
   * Never transfer `children`.
   */
  children: emptyFunction,
  /**
   * Transfer the `className` prop by merging them.
   */
  className: createTransferStrategy(joinClasses),
  /**
   * Transfer the `style` prop (which is an object) by merging them.
   */
  style: transferStrategyMerge
};

/**
 * Mutates the first argument by transferring the properties from the second
 * argument.
 *
 * @param {object} props
 * @param {object} newProps
 * @return {object}
 */
function transferInto(props, newProps) {
  for (var thisKey in newProps) {
    if (!newProps.hasOwnProperty(thisKey)) {
      continue;
    }

    var transferStrategy = TransferStrategies[thisKey];

    if (transferStrategy && TransferStrategies.hasOwnProperty(thisKey)) {
      transferStrategy(props, thisKey, newProps[thisKey]);
    } else if (!props.hasOwnProperty(thisKey)) {
      props[thisKey] = newProps[thisKey];
    }
  }
  return props;
}

/**
 * ReactPropTransferer are capable of transferring props to another component
 * using a `transferPropsTo` method.
 *
 * @class ReactPropTransferer
 */
var ReactPropTransferer = {

  TransferStrategies: TransferStrategies,

  /**
   * Merge two props objects using TransferStrategies.
   *
   * @param {object} oldProps original props (they take precedence)
   * @param {object} newProps new props to merge in
   * @return {object} a new object containing both sets of props merged.
   */
  mergeProps: function(oldProps, newProps) {
    return transferInto(assign({}, oldProps), newProps);
  },

  /**
   * @lends {ReactPropTransferer.prototype}
   */
  Mixin: {

    /**
     * Transfer props from this component to a target component.
     *
     * Props that do not have an explicit transfer strategy will be transferred
     * only if the target component does not already have the prop set.
     *
     * This is usually used to pass down props to a returned root component.
     *
     * @param {ReactElement} element Component receiving the properties.
     * @return {ReactElement} The supplied `component`.
     * @final
     * @protected
     */
    transferPropsTo: function(element) {
      ("production" !== process.env.NODE_ENV ? invariant(
        element._owner === this,
        '%s: You can\'t call transferPropsTo() on a component that you ' +
        'don\'t own, %s. This usually means you are calling ' +
        'transferPropsTo() on a component passed in as props or children.',
        this.constructor.displayName,
        typeof element.type === 'string' ?
        element.type :
        element.type.displayName
      ) : invariant(element._owner === this));

      if ("production" !== process.env.NODE_ENV) {
        if (!didWarn) {
          didWarn = true;
          ("production" !== process.env.NODE_ENV ? warning(
            false,
            'transferPropsTo is deprecated. ' +
            'See http://fb.me/react-transferpropsto for more information.'
          ) : null);
        }
      }

      // Because elements are immutable we have to merge into the existing
      // props object rather than clone it.
      transferInto(element.props, this.props);

      return element;
    }

  }
};

module.exports = ReactPropTransferer;

}).call(this,require('_process'))
},{"./Object.assign":26,"./emptyFunction":107,"./invariant":126,"./joinClasses":131,"./warning":145,"_process":152}],70:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPropTypeLocationNames
 */

"use strict";

var ReactPropTypeLocationNames = {};

if ("production" !== process.env.NODE_ENV) {
  ReactPropTypeLocationNames = {
    prop: 'prop',
    context: 'context',
    childContext: 'child context'
  };
}

module.exports = ReactPropTypeLocationNames;

}).call(this,require('_process'))
},{"_process":152}],71:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPropTypeLocations
 */

"use strict";

var keyMirror = require("./keyMirror");

var ReactPropTypeLocations = keyMirror({
  prop: null,
  context: null,
  childContext: null
});

module.exports = ReactPropTypeLocations;

},{"./keyMirror":132}],72:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPropTypes
 */

"use strict";

var ReactElement = require("./ReactElement");
var ReactPropTypeLocationNames = require("./ReactPropTypeLocationNames");

var deprecated = require("./deprecated");
var emptyFunction = require("./emptyFunction");

/**
 * Collection of methods that allow declaration and validation of props that are
 * supplied to React components. Example usage:
 *
 *   var Props = require('ReactPropTypes');
 *   var MyArticle = React.createClass({
 *     propTypes: {
 *       // An optional string prop named "description".
 *       description: Props.string,
 *
 *       // A required enum prop named "category".
 *       category: Props.oneOf(['News','Photos']).isRequired,
 *
 *       // A prop named "dialog" that requires an instance of Dialog.
 *       dialog: Props.instanceOf(Dialog).isRequired
 *     },
 *     render: function() { ... }
 *   });
 *
 * A more formal specification of how these methods are used:
 *
 *   type := array|bool|func|object|number|string|oneOf([...])|instanceOf(...)
 *   decl := ReactPropTypes.{type}(.isRequired)?
 *
 * Each and every declaration produces a function with the same signature. This
 * allows the creation of custom validation functions. For example:
 *
 *  var MyLink = React.createClass({
 *    propTypes: {
 *      // An optional string or URI prop named "href".
 *      href: function(props, propName, componentName) {
 *        var propValue = props[propName];
 *        if (propValue != null && typeof propValue !== 'string' &&
 *            !(propValue instanceof URI)) {
 *          return new Error(
 *            'Expected a string or an URI for ' + propName + ' in ' +
 *            componentName
 *          );
 *        }
 *      }
 *    },
 *    render: function() {...}
 *  });
 *
 * @internal
 */

var ANONYMOUS = '<<anonymous>>';

var elementTypeChecker = createElementTypeChecker();
var nodeTypeChecker = createNodeChecker();

var ReactPropTypes = {
  array: createPrimitiveTypeChecker('array'),
  bool: createPrimitiveTypeChecker('boolean'),
  func: createPrimitiveTypeChecker('function'),
  number: createPrimitiveTypeChecker('number'),
  object: createPrimitiveTypeChecker('object'),
  string: createPrimitiveTypeChecker('string'),

  any: createAnyTypeChecker(),
  arrayOf: createArrayOfTypeChecker,
  element: elementTypeChecker,
  instanceOf: createInstanceTypeChecker,
  node: nodeTypeChecker,
  objectOf: createObjectOfTypeChecker,
  oneOf: createEnumTypeChecker,
  oneOfType: createUnionTypeChecker,
  shape: createShapeTypeChecker,

  component: deprecated(
    'React.PropTypes',
    'component',
    'element',
    this,
    elementTypeChecker
  ),
  renderable: deprecated(
    'React.PropTypes',
    'renderable',
    'node',
    this,
    nodeTypeChecker
  )
};

function createChainableTypeChecker(validate) {
  function checkType(isRequired, props, propName, componentName, location) {
    componentName = componentName || ANONYMOUS;
    if (props[propName] == null) {
      var locationName = ReactPropTypeLocationNames[location];
      if (isRequired) {
        return new Error(
          ("Required " + locationName + " `" + propName + "` was not specified in ")+
          ("`" + componentName + "`.")
        );
      }
    } else {
      return validate(props, propName, componentName, location);
    }
  }

  var chainedCheckType = checkType.bind(null, false);
  chainedCheckType.isRequired = checkType.bind(null, true);

  return chainedCheckType;
}

function createPrimitiveTypeChecker(expectedType) {
  function validate(props, propName, componentName, location) {
    var propValue = props[propName];
    var propType = getPropType(propValue);
    if (propType !== expectedType) {
      var locationName = ReactPropTypeLocationNames[location];
      // `propValue` being instance of, say, date/regexp, pass the 'object'
      // check, but we can offer a more precise error message here rather than
      // 'of type `object`'.
      var preciseType = getPreciseType(propValue);

      return new Error(
        ("Invalid " + locationName + " `" + propName + "` of type `" + preciseType + "` ") +
        ("supplied to `" + componentName + "`, expected `" + expectedType + "`.")
      );
    }
  }
  return createChainableTypeChecker(validate);
}

function createAnyTypeChecker() {
  return createChainableTypeChecker(emptyFunction.thatReturns());
}

function createArrayOfTypeChecker(typeChecker) {
  function validate(props, propName, componentName, location) {
    var propValue = props[propName];
    if (!Array.isArray(propValue)) {
      var locationName = ReactPropTypeLocationNames[location];
      var propType = getPropType(propValue);
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` of type ") +
        ("`" + propType + "` supplied to `" + componentName + "`, expected an array.")
      );
    }
    for (var i = 0; i < propValue.length; i++) {
      var error = typeChecker(propValue, i, componentName, location);
      if (error instanceof Error) {
        return error;
      }
    }
  }
  return createChainableTypeChecker(validate);
}

function createElementTypeChecker() {
  function validate(props, propName, componentName, location) {
    if (!ReactElement.isValidElement(props[propName])) {
      var locationName = ReactPropTypeLocationNames[location];
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` supplied to ") +
        ("`" + componentName + "`, expected a ReactElement.")
      );
    }
  }
  return createChainableTypeChecker(validate);
}

function createInstanceTypeChecker(expectedClass) {
  function validate(props, propName, componentName, location) {
    if (!(props[propName] instanceof expectedClass)) {
      var locationName = ReactPropTypeLocationNames[location];
      var expectedClassName = expectedClass.name || ANONYMOUS;
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` supplied to ") +
        ("`" + componentName + "`, expected instance of `" + expectedClassName + "`.")
      );
    }
  }
  return createChainableTypeChecker(validate);
}

function createEnumTypeChecker(expectedValues) {
  function validate(props, propName, componentName, location) {
    var propValue = props[propName];
    for (var i = 0; i < expectedValues.length; i++) {
      if (propValue === expectedValues[i]) {
        return;
      }
    }

    var locationName = ReactPropTypeLocationNames[location];
    var valuesString = JSON.stringify(expectedValues);
    return new Error(
      ("Invalid " + locationName + " `" + propName + "` of value `" + propValue + "` ") +
      ("supplied to `" + componentName + "`, expected one of " + valuesString + ".")
    );
  }
  return createChainableTypeChecker(validate);
}

function createObjectOfTypeChecker(typeChecker) {
  function validate(props, propName, componentName, location) {
    var propValue = props[propName];
    var propType = getPropType(propValue);
    if (propType !== 'object') {
      var locationName = ReactPropTypeLocationNames[location];
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` of type ") +
        ("`" + propType + "` supplied to `" + componentName + "`, expected an object.")
      );
    }
    for (var key in propValue) {
      if (propValue.hasOwnProperty(key)) {
        var error = typeChecker(propValue, key, componentName, location);
        if (error instanceof Error) {
          return error;
        }
      }
    }
  }
  return createChainableTypeChecker(validate);
}

function createUnionTypeChecker(arrayOfTypeCheckers) {
  function validate(props, propName, componentName, location) {
    for (var i = 0; i < arrayOfTypeCheckers.length; i++) {
      var checker = arrayOfTypeCheckers[i];
      if (checker(props, propName, componentName, location) == null) {
        return;
      }
    }

    var locationName = ReactPropTypeLocationNames[location];
    return new Error(
      ("Invalid " + locationName + " `" + propName + "` supplied to ") +
      ("`" + componentName + "`.")
    );
  }
  return createChainableTypeChecker(validate);
}

function createNodeChecker() {
  function validate(props, propName, componentName, location) {
    if (!isNode(props[propName])) {
      var locationName = ReactPropTypeLocationNames[location];
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` supplied to ") +
        ("`" + componentName + "`, expected a ReactNode.")
      );
    }
  }
  return createChainableTypeChecker(validate);
}

function createShapeTypeChecker(shapeTypes) {
  function validate(props, propName, componentName, location) {
    var propValue = props[propName];
    var propType = getPropType(propValue);
    if (propType !== 'object') {
      var locationName = ReactPropTypeLocationNames[location];
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` of type `" + propType + "` ") +
        ("supplied to `" + componentName + "`, expected `object`.")
      );
    }
    for (var key in shapeTypes) {
      var checker = shapeTypes[key];
      if (!checker) {
        continue;
      }
      var error = checker(propValue, key, componentName, location);
      if (error) {
        return error;
      }
    }
  }
  return createChainableTypeChecker(validate, 'expected `object`');
}

function isNode(propValue) {
  switch(typeof propValue) {
    case 'number':
    case 'string':
      return true;
    case 'boolean':
      return !propValue;
    case 'object':
      if (Array.isArray(propValue)) {
        return propValue.every(isNode);
      }
      if (ReactElement.isValidElement(propValue)) {
        return true;
      }
      for (var k in propValue) {
        if (!isNode(propValue[k])) {
          return false;
        }
      }
      return true;
    default:
      return false;
  }
}

// Equivalent of `typeof` but with special handling for array and regexp.
function getPropType(propValue) {
  var propType = typeof propValue;
  if (Array.isArray(propValue)) {
    return 'array';
  }
  if (propValue instanceof RegExp) {
    // Old webkits (at least until Android 4.0) return 'function' rather than
    // 'object' for typeof a RegExp. We'll normalize this here so that /bla/
    // passes PropTypes.object.
    return 'object';
  }
  return propType;
}

// This handles more types than `getPropType`. Only used for error messages.
// See `createPrimitiveTypeChecker`.
function getPreciseType(propValue) {
  var propType = getPropType(propValue);
  if (propType === 'object') {
    if (propValue instanceof Date) {
      return 'date';
    } else if (propValue instanceof RegExp) {
      return 'regexp';
    }
  }
  return propType;
}

module.exports = ReactPropTypes;

},{"./ReactElement":52,"./ReactPropTypeLocationNames":70,"./deprecated":106,"./emptyFunction":107}],73:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPutListenerQueue
 */

"use strict";

var PooledClass = require("./PooledClass");
var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");

var assign = require("./Object.assign");

function ReactPutListenerQueue() {
  this.listenersToPut = [];
}

assign(ReactPutListenerQueue.prototype, {
  enqueuePutListener: function(rootNodeID, propKey, propValue) {
    this.listenersToPut.push({
      rootNodeID: rootNodeID,
      propKey: propKey,
      propValue: propValue
    });
  },

  putListeners: function() {
    for (var i = 0; i < this.listenersToPut.length; i++) {
      var listenerToPut = this.listenersToPut[i];
      ReactBrowserEventEmitter.putListener(
        listenerToPut.rootNodeID,
        listenerToPut.propKey,
        listenerToPut.propValue
      );
    }
  },

  reset: function() {
    this.listenersToPut.length = 0;
  },

  destructor: function() {
    this.reset();
  }
});

PooledClass.addPoolingTo(ReactPutListenerQueue);

module.exports = ReactPutListenerQueue;

},{"./Object.assign":26,"./PooledClass":27,"./ReactBrowserEventEmitter":30}],74:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactReconcileTransaction
 * @typechecks static-only
 */

"use strict";

var CallbackQueue = require("./CallbackQueue");
var PooledClass = require("./PooledClass");
var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");
var ReactInputSelection = require("./ReactInputSelection");
var ReactPutListenerQueue = require("./ReactPutListenerQueue");
var Transaction = require("./Transaction");

var assign = require("./Object.assign");

/**
 * Ensures that, when possible, the selection range (currently selected text
 * input) is not disturbed by performing the transaction.
 */
var SELECTION_RESTORATION = {
  /**
   * @return {Selection} Selection information.
   */
  initialize: ReactInputSelection.getSelectionInformation,
  /**
   * @param {Selection} sel Selection information returned from `initialize`.
   */
  close: ReactInputSelection.restoreSelection
};

/**
 * Suppresses events (blur/focus) that could be inadvertently dispatched due to
 * high level DOM manipulations (like temporarily removing a text input from the
 * DOM).
 */
var EVENT_SUPPRESSION = {
  /**
   * @return {boolean} The enabled status of `ReactBrowserEventEmitter` before
   * the reconciliation.
   */
  initialize: function() {
    var currentlyEnabled = ReactBrowserEventEmitter.isEnabled();
    ReactBrowserEventEmitter.setEnabled(false);
    return currentlyEnabled;
  },

  /**
   * @param {boolean} previouslyEnabled Enabled status of
   *   `ReactBrowserEventEmitter` before the reconciliation occured. `close`
   *   restores the previous value.
   */
  close: function(previouslyEnabled) {
    ReactBrowserEventEmitter.setEnabled(previouslyEnabled);
  }
};

/**
 * Provides a queue for collecting `componentDidMount` and
 * `componentDidUpdate` callbacks during the the transaction.
 */
var ON_DOM_READY_QUEUEING = {
  /**
   * Initializes the internal `onDOMReady` queue.
   */
  initialize: function() {
    this.reactMountReady.reset();
  },

  /**
   * After DOM is flushed, invoke all registered `onDOMReady` callbacks.
   */
  close: function() {
    this.reactMountReady.notifyAll();
  }
};

var PUT_LISTENER_QUEUEING = {
  initialize: function() {
    this.putListenerQueue.reset();
  },

  close: function() {
    this.putListenerQueue.putListeners();
  }
};

/**
 * Executed within the scope of the `Transaction` instance. Consider these as
 * being member methods, but with an implied ordering while being isolated from
 * each other.
 */
var TRANSACTION_WRAPPERS = [
  PUT_LISTENER_QUEUEING,
  SELECTION_RESTORATION,
  EVENT_SUPPRESSION,
  ON_DOM_READY_QUEUEING
];

/**
 * Currently:
 * - The order that these are listed in the transaction is critical:
 * - Suppresses events.
 * - Restores selection range.
 *
 * Future:
 * - Restore document/overflow scroll positions that were unintentionally
 *   modified via DOM insertions above the top viewport boundary.
 * - Implement/integrate with customized constraint based layout system and keep
 *   track of which dimensions must be remeasured.
 *
 * @class ReactReconcileTransaction
 */
function ReactReconcileTransaction() {
  this.reinitializeTransaction();
  // Only server-side rendering really needs this option (see
  // `ReactServerRendering`), but server-side uses
  // `ReactServerRenderingTransaction` instead. This option is here so that it's
  // accessible and defaults to false when `ReactDOMComponent` and
  // `ReactTextComponent` checks it in `mountComponent`.`
  this.renderToStaticMarkup = false;
  this.reactMountReady = CallbackQueue.getPooled(null);
  this.putListenerQueue = ReactPutListenerQueue.getPooled();
}

var Mixin = {
  /**
   * @see Transaction
   * @abstract
   * @final
   * @return {array<object>} List of operation wrap proceedures.
   *   TODO: convert to array<TransactionWrapper>
   */
  getTransactionWrappers: function() {
    return TRANSACTION_WRAPPERS;
  },

  /**
   * @return {object} The queue to collect `onDOMReady` callbacks with.
   */
  getReactMountReady: function() {
    return this.reactMountReady;
  },

  getPutListenerQueue: function() {
    return this.putListenerQueue;
  },

  /**
   * `PooledClass` looks for this, and will invoke this before allowing this
   * instance to be resused.
   */
  destructor: function() {
    CallbackQueue.release(this.reactMountReady);
    this.reactMountReady = null;

    ReactPutListenerQueue.release(this.putListenerQueue);
    this.putListenerQueue = null;
  }
};


assign(ReactReconcileTransaction.prototype, Transaction.Mixin, Mixin);

PooledClass.addPoolingTo(ReactReconcileTransaction);

module.exports = ReactReconcileTransaction;

},{"./CallbackQueue":5,"./Object.assign":26,"./PooledClass":27,"./ReactBrowserEventEmitter":30,"./ReactInputSelection":59,"./ReactPutListenerQueue":73,"./Transaction":95}],75:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactRootIndex
 * @typechecks
 */

"use strict";

var ReactRootIndexInjection = {
  /**
   * @param {function} _createReactRootIndex
   */
  injectCreateReactRootIndex: function(_createReactRootIndex) {
    ReactRootIndex.createReactRootIndex = _createReactRootIndex;
  }
};

var ReactRootIndex = {
  createReactRootIndex: null,
  injection: ReactRootIndexInjection
};

module.exports = ReactRootIndex;

},{}],76:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @typechecks static-only
 * @providesModule ReactServerRendering
 */
"use strict";

var ReactElement = require("./ReactElement");
var ReactInstanceHandles = require("./ReactInstanceHandles");
var ReactMarkupChecksum = require("./ReactMarkupChecksum");
var ReactServerRenderingTransaction =
  require("./ReactServerRenderingTransaction");

var instantiateReactComponent = require("./instantiateReactComponent");
var invariant = require("./invariant");

/**
 * @param {ReactElement} element
 * @return {string} the HTML markup
 */
function renderToString(element) {
  ("production" !== process.env.NODE_ENV ? invariant(
    ReactElement.isValidElement(element),
    'renderToString(): You must pass a valid ReactElement.'
  ) : invariant(ReactElement.isValidElement(element)));

  var transaction;
  try {
    var id = ReactInstanceHandles.createReactRootID();
    transaction = ReactServerRenderingTransaction.getPooled(false);

    return transaction.perform(function() {
      var componentInstance = instantiateReactComponent(element, null);
      var markup = componentInstance.mountComponent(id, transaction, 0);
      return ReactMarkupChecksum.addChecksumToMarkup(markup);
    }, null);
  } finally {
    ReactServerRenderingTransaction.release(transaction);
  }
}

/**
 * @param {ReactElement} element
 * @return {string} the HTML markup, without the extra React ID and checksum
 * (for generating static pages)
 */
function renderToStaticMarkup(element) {
  ("production" !== process.env.NODE_ENV ? invariant(
    ReactElement.isValidElement(element),
    'renderToStaticMarkup(): You must pass a valid ReactElement.'
  ) : invariant(ReactElement.isValidElement(element)));

  var transaction;
  try {
    var id = ReactInstanceHandles.createReactRootID();
    transaction = ReactServerRenderingTransaction.getPooled(true);

    return transaction.perform(function() {
      var componentInstance = instantiateReactComponent(element, null);
      return componentInstance.mountComponent(id, transaction, 0);
    }, null);
  } finally {
    ReactServerRenderingTransaction.release(transaction);
  }
}

module.exports = {
  renderToString: renderToString,
  renderToStaticMarkup: renderToStaticMarkup
};

}).call(this,require('_process'))
},{"./ReactElement":52,"./ReactInstanceHandles":60,"./ReactMarkupChecksum":62,"./ReactServerRenderingTransaction":77,"./instantiateReactComponent":125,"./invariant":126,"_process":152}],77:[function(require,module,exports){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactServerRenderingTransaction
 * @typechecks
 */

"use strict";

var PooledClass = require("./PooledClass");
var CallbackQueue = require("./CallbackQueue");
var ReactPutListenerQueue = require("./ReactPutListenerQueue");
var Transaction = require("./Transaction");

var assign = require("./Object.assign");
var emptyFunction = require("./emptyFunction");

/**
 * Provides a `CallbackQueue` queue for collecting `onDOMReady` callbacks
 * during the performing of the transaction.
 */
var ON_DOM_READY_QUEUEING = {
  /**
   * Initializes the internal `onDOMReady` queue.
   */
  initialize: function() {
    this.reactMountReady.reset();
  },

  close: emptyFunction
};

var PUT_LISTENER_QUEUEING = {
  initialize: function() {
    this.putListenerQueue.reset();
  },

  close: emptyFunction
};

/**
 * Executed within the scope of the `Transaction` instance. Consider these as
 * being member methods, but with an implied ordering while being isolated from
 * each other.
 */
var TRANSACTION_WRAPPERS = [
  PUT_LISTENER_QUEUEING,
  ON_DOM_READY_QUEUEING
];

/**
 * @class ReactServerRenderingTransaction
 * @param {boolean} renderToStaticMarkup
 */
function ReactServerRenderingTransaction(renderToStaticMarkup) {
  this.reinitializeTransaction();
  this.renderToStaticMarkup = renderToStaticMarkup;
  this.reactMountReady = CallbackQueue.getPooled(null);
  this.putListenerQueue = ReactPutListenerQueue.getPooled();
}

var Mixin = {
  /**
   * @see Transaction
   * @abstract
   * @final
   * @return {array} Empty list of operation wrap proceedures.
   */
  getTransactionWrappers: function() {
    return TRANSACTION_WRAPPERS;
  },

  /**
   * @return {object} The queue to collect `onDOMReady` callbacks with.
   */
  getReactMountReady: function() {
    return this.reactMountReady;
  },

  getPutListenerQueue: function() {
    return this.putListenerQueue;
  },

  /**
   * `PooledClass` looks for this, and will invoke this before allowing this
   * instance to be resused.
   */
  destructor: function() {
    CallbackQueue.release(this.reactMountReady);
    this.reactMountReady = null;

    ReactPutListenerQueue.release(this.putListenerQueue);
    this.putListenerQueue = null;
  }
};


assign(
  ReactServerRenderingTransaction.prototype,
  Transaction.Mixin,
  Mixin
);

PooledClass.addPoolingTo(ReactServerRenderingTransaction);

module.exports = ReactServerRenderingTransaction;

},{"./CallbackQueue":5,"./Object.assign":26,"./PooledClass":27,"./ReactPutListenerQueue":73,"./Transaction":95,"./emptyFunction":107}],78:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactTextComponent
 * @typechecks static-only
 */

"use strict";

var DOMPropertyOperations = require("./DOMPropertyOperations");
var ReactComponent = require("./ReactComponent");
var ReactElement = require("./ReactElement");

var assign = require("./Object.assign");
var escapeTextForBrowser = require("./escapeTextForBrowser");

/**
 * Text nodes violate a couple assumptions that React makes about components:
 *
 *  - When mounting text into the DOM, adjacent text nodes are merged.
 *  - Text nodes cannot be assigned a React root ID.
 *
 * This component is used to wrap strings in elements so that they can undergo
 * the same reconciliation that is applied to elements.
 *
 * TODO: Investigate representing React components in the DOM with text nodes.
 *
 * @class ReactTextComponent
 * @extends ReactComponent
 * @internal
 */
var ReactTextComponent = function(props) {
  // This constructor and it's argument is currently used by mocks.
};

assign(ReactTextComponent.prototype, ReactComponent.Mixin, {

  /**
   * Creates the markup for this text node. This node is not intended to have
   * any features besides containing text content.
   *
   * @param {string} rootID DOM ID of the root node.
   * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
   * @param {number} mountDepth number of components in the owner hierarchy
   * @return {string} Markup for this text node.
   * @internal
   */
  mountComponent: function(rootID, transaction, mountDepth) {
    ReactComponent.Mixin.mountComponent.call(
      this,
      rootID,
      transaction,
      mountDepth
    );

    var escapedText = escapeTextForBrowser(this.props);

    if (transaction.renderToStaticMarkup) {
      // Normally we'd wrap this in a `span` for the reasons stated above, but
      // since this is a situation where React won't take over (static pages),
      // we can simply return the text as it is.
      return escapedText;
    }

    return (
      '<span ' + DOMPropertyOperations.createMarkupForID(rootID) + '>' +
        escapedText +
      '</span>'
    );
  },

  /**
   * Updates this component by updating the text content.
   *
   * @param {object} nextComponent Contains the next text content.
   * @param {ReactReconcileTransaction} transaction
   * @internal
   */
  receiveComponent: function(nextComponent, transaction) {
    var nextProps = nextComponent.props;
    if (nextProps !== this.props) {
      this.props = nextProps;
      ReactComponent.BackendIDOperations.updateTextContentByID(
        this._rootNodeID,
        nextProps
      );
    }
  }

});

var ReactTextComponentFactory = function(text) {
  // Bypass validation and configuration
  return new ReactElement(ReactTextComponent, null, null, null, null, text);
};

ReactTextComponentFactory.type = ReactTextComponent;

module.exports = ReactTextComponentFactory;

},{"./DOMPropertyOperations":11,"./Object.assign":26,"./ReactComponent":32,"./ReactElement":52,"./escapeTextForBrowser":109}],79:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactUpdates
 */

"use strict";

var CallbackQueue = require("./CallbackQueue");
var PooledClass = require("./PooledClass");
var ReactCurrentOwner = require("./ReactCurrentOwner");
var ReactPerf = require("./ReactPerf");
var Transaction = require("./Transaction");

var assign = require("./Object.assign");
var invariant = require("./invariant");
var warning = require("./warning");

var dirtyComponents = [];
var asapCallbackQueue = CallbackQueue.getPooled();
var asapEnqueued = false;

var batchingStrategy = null;

function ensureInjected() {
  ("production" !== process.env.NODE_ENV ? invariant(
    ReactUpdates.ReactReconcileTransaction && batchingStrategy,
    'ReactUpdates: must inject a reconcile transaction class and batching ' +
    'strategy'
  ) : invariant(ReactUpdates.ReactReconcileTransaction && batchingStrategy));
}

var NESTED_UPDATES = {
  initialize: function() {
    this.dirtyComponentsLength = dirtyComponents.length;
  },
  close: function() {
    if (this.dirtyComponentsLength !== dirtyComponents.length) {
      // Additional updates were enqueued by componentDidUpdate handlers or
      // similar; before our own UPDATE_QUEUEING wrapper closes, we want to run
      // these new updates so that if A's componentDidUpdate calls setState on
      // B, B will update before the callback A's updater provided when calling
      // setState.
      dirtyComponents.splice(0, this.dirtyComponentsLength);
      flushBatchedUpdates();
    } else {
      dirtyComponents.length = 0;
    }
  }
};

var UPDATE_QUEUEING = {
  initialize: function() {
    this.callbackQueue.reset();
  },
  close: function() {
    this.callbackQueue.notifyAll();
  }
};

var TRANSACTION_WRAPPERS = [NESTED_UPDATES, UPDATE_QUEUEING];

function ReactUpdatesFlushTransaction() {
  this.reinitializeTransaction();
  this.dirtyComponentsLength = null;
  this.callbackQueue = CallbackQueue.getPooled();
  this.reconcileTransaction =
    ReactUpdates.ReactReconcileTransaction.getPooled();
}

assign(
  ReactUpdatesFlushTransaction.prototype,
  Transaction.Mixin, {
  getTransactionWrappers: function() {
    return TRANSACTION_WRAPPERS;
  },

  destructor: function() {
    this.dirtyComponentsLength = null;
    CallbackQueue.release(this.callbackQueue);
    this.callbackQueue = null;
    ReactUpdates.ReactReconcileTransaction.release(this.reconcileTransaction);
    this.reconcileTransaction = null;
  },

  perform: function(method, scope, a) {
    // Essentially calls `this.reconcileTransaction.perform(method, scope, a)`
    // with this transaction's wrappers around it.
    return Transaction.Mixin.perform.call(
      this,
      this.reconcileTransaction.perform,
      this.reconcileTransaction,
      method,
      scope,
      a
    );
  }
});

PooledClass.addPoolingTo(ReactUpdatesFlushTransaction);

function batchedUpdates(callback, a, b) {
  ensureInjected();
  batchingStrategy.batchedUpdates(callback, a, b);
}

/**
 * Array comparator for ReactComponents by owner depth
 *
 * @param {ReactComponent} c1 first component you're comparing
 * @param {ReactComponent} c2 second component you're comparing
 * @return {number} Return value usable by Array.prototype.sort().
 */
function mountDepthComparator(c1, c2) {
  return c1._mountDepth - c2._mountDepth;
}

function runBatchedUpdates(transaction) {
  var len = transaction.dirtyComponentsLength;
  ("production" !== process.env.NODE_ENV ? invariant(
    len === dirtyComponents.length,
    'Expected flush transaction\'s stored dirty-components length (%s) to ' +
    'match dirty-components array length (%s).',
    len,
    dirtyComponents.length
  ) : invariant(len === dirtyComponents.length));

  // Since reconciling a component higher in the owner hierarchy usually (not
  // always -- see shouldComponentUpdate()) will reconcile children, reconcile
  // them before their children by sorting the array.
  dirtyComponents.sort(mountDepthComparator);

  for (var i = 0; i < len; i++) {
    // If a component is unmounted before pending changes apply, ignore them
    // TODO: Queue unmounts in the same list to avoid this happening at all
    var component = dirtyComponents[i];
    if (component.isMounted()) {
      // If performUpdateIfNecessary happens to enqueue any new updates, we
      // shouldn't execute the callbacks until the next render happens, so
      // stash the callbacks first
      var callbacks = component._pendingCallbacks;
      component._pendingCallbacks = null;
      component.performUpdateIfNecessary(transaction.reconcileTransaction);

      if (callbacks) {
        for (var j = 0; j < callbacks.length; j++) {
          transaction.callbackQueue.enqueue(
            callbacks[j],
            component
          );
        }
      }
    }
  }
}

var flushBatchedUpdates = ReactPerf.measure(
  'ReactUpdates',
  'flushBatchedUpdates',
  function() {
    // ReactUpdatesFlushTransaction's wrappers will clear the dirtyComponents
    // array and perform any updates enqueued by mount-ready handlers (i.e.,
    // componentDidUpdate) but we need to check here too in order to catch
    // updates enqueued by setState callbacks and asap calls.
    while (dirtyComponents.length || asapEnqueued) {
      if (dirtyComponents.length) {
        var transaction = ReactUpdatesFlushTransaction.getPooled();
        transaction.perform(runBatchedUpdates, null, transaction);
        ReactUpdatesFlushTransaction.release(transaction);
      }

      if (asapEnqueued) {
        asapEnqueued = false;
        var queue = asapCallbackQueue;
        asapCallbackQueue = CallbackQueue.getPooled();
        queue.notifyAll();
        CallbackQueue.release(queue);
      }
    }
  }
);

/**
 * Mark a component as needing a rerender, adding an optional callback to a
 * list of functions which will be executed once the rerender occurs.
 */
function enqueueUpdate(component, callback) {
  ("production" !== process.env.NODE_ENV ? invariant(
    !callback || typeof callback === "function",
    'enqueueUpdate(...): You called `setProps`, `replaceProps`, ' +
    '`setState`, `replaceState`, or `forceUpdate` with a callback that ' +
    'isn\'t callable.'
  ) : invariant(!callback || typeof callback === "function"));
  ensureInjected();

  // Various parts of our code (such as ReactCompositeComponent's
  // _renderValidatedComponent) assume that calls to render aren't nested;
  // verify that that's the case. (This is called by each top-level update
  // function, like setProps, setState, forceUpdate, etc.; creation and
  // destruction of top-level components is guarded in ReactMount.)
  ("production" !== process.env.NODE_ENV ? warning(
    ReactCurrentOwner.current == null,
    'enqueueUpdate(): Render methods should be a pure function of props ' +
    'and state; triggering nested component updates from render is not ' +
    'allowed. If necessary, trigger nested updates in ' +
    'componentDidUpdate.'
  ) : null);

  if (!batchingStrategy.isBatchingUpdates) {
    batchingStrategy.batchedUpdates(enqueueUpdate, component, callback);
    return;
  }

  dirtyComponents.push(component);

  if (callback) {
    if (component._pendingCallbacks) {
      component._pendingCallbacks.push(callback);
    } else {
      component._pendingCallbacks = [callback];
    }
  }
}

/**
 * Enqueue a callback to be run at the end of the current batching cycle. Throws
 * if no updates are currently being performed.
 */
function asap(callback, context) {
  ("production" !== process.env.NODE_ENV ? invariant(
    batchingStrategy.isBatchingUpdates,
    'ReactUpdates.asap: Can\'t enqueue an asap callback in a context where' +
    'updates are not being batched.'
  ) : invariant(batchingStrategy.isBatchingUpdates));
  asapCallbackQueue.enqueue(callback, context);
  asapEnqueued = true;
}

var ReactUpdatesInjection = {
  injectReconcileTransaction: function(ReconcileTransaction) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ReconcileTransaction,
      'ReactUpdates: must provide a reconcile transaction class'
    ) : invariant(ReconcileTransaction));
    ReactUpdates.ReactReconcileTransaction = ReconcileTransaction;
  },

  injectBatchingStrategy: function(_batchingStrategy) {
    ("production" !== process.env.NODE_ENV ? invariant(
      _batchingStrategy,
      'ReactUpdates: must provide a batching strategy'
    ) : invariant(_batchingStrategy));
    ("production" !== process.env.NODE_ENV ? invariant(
      typeof _batchingStrategy.batchedUpdates === 'function',
      'ReactUpdates: must provide a batchedUpdates() function'
    ) : invariant(typeof _batchingStrategy.batchedUpdates === 'function'));
    ("production" !== process.env.NODE_ENV ? invariant(
      typeof _batchingStrategy.isBatchingUpdates === 'boolean',
      'ReactUpdates: must provide an isBatchingUpdates boolean attribute'
    ) : invariant(typeof _batchingStrategy.isBatchingUpdates === 'boolean'));
    batchingStrategy = _batchingStrategy;
  }
};

var ReactUpdates = {
  /**
   * React references `ReactReconcileTransaction` using this property in order
   * to allow dependency injection.
   *
   * @internal
   */
  ReactReconcileTransaction: null,

  batchedUpdates: batchedUpdates,
  enqueueUpdate: enqueueUpdate,
  flushBatchedUpdates: flushBatchedUpdates,
  injection: ReactUpdatesInjection,
  asap: asap
};

module.exports = ReactUpdates;

}).call(this,require('_process'))
},{"./CallbackQueue":5,"./Object.assign":26,"./PooledClass":27,"./ReactCurrentOwner":36,"./ReactPerf":68,"./Transaction":95,"./invariant":126,"./warning":145,"_process":152}],80:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SVGDOMPropertyConfig
 */

/*jslint bitwise: true*/

"use strict";

var DOMProperty = require("./DOMProperty");

var MUST_USE_ATTRIBUTE = DOMProperty.injection.MUST_USE_ATTRIBUTE;

var SVGDOMPropertyConfig = {
  Properties: {
    cx: MUST_USE_ATTRIBUTE,
    cy: MUST_USE_ATTRIBUTE,
    d: MUST_USE_ATTRIBUTE,
    dx: MUST_USE_ATTRIBUTE,
    dy: MUST_USE_ATTRIBUTE,
    fill: MUST_USE_ATTRIBUTE,
    fillOpacity: MUST_USE_ATTRIBUTE,
    fontFamily: MUST_USE_ATTRIBUTE,
    fontSize: MUST_USE_ATTRIBUTE,
    fx: MUST_USE_ATTRIBUTE,
    fy: MUST_USE_ATTRIBUTE,
    gradientTransform: MUST_USE_ATTRIBUTE,
    gradientUnits: MUST_USE_ATTRIBUTE,
    markerEnd: MUST_USE_ATTRIBUTE,
    markerMid: MUST_USE_ATTRIBUTE,
    markerStart: MUST_USE_ATTRIBUTE,
    offset: MUST_USE_ATTRIBUTE,
    opacity: MUST_USE_ATTRIBUTE,
    patternContentUnits: MUST_USE_ATTRIBUTE,
    patternUnits: MUST_USE_ATTRIBUTE,
    points: MUST_USE_ATTRIBUTE,
    preserveAspectRatio: MUST_USE_ATTRIBUTE,
    r: MUST_USE_ATTRIBUTE,
    rx: MUST_USE_ATTRIBUTE,
    ry: MUST_USE_ATTRIBUTE,
    spreadMethod: MUST_USE_ATTRIBUTE,
    stopColor: MUST_USE_ATTRIBUTE,
    stopOpacity: MUST_USE_ATTRIBUTE,
    stroke: MUST_USE_ATTRIBUTE,
    strokeDasharray: MUST_USE_ATTRIBUTE,
    strokeLinecap: MUST_USE_ATTRIBUTE,
    strokeOpacity: MUST_USE_ATTRIBUTE,
    strokeWidth: MUST_USE_ATTRIBUTE,
    textAnchor: MUST_USE_ATTRIBUTE,
    transform: MUST_USE_ATTRIBUTE,
    version: MUST_USE_ATTRIBUTE,
    viewBox: MUST_USE_ATTRIBUTE,
    x1: MUST_USE_ATTRIBUTE,
    x2: MUST_USE_ATTRIBUTE,
    x: MUST_USE_ATTRIBUTE,
    y1: MUST_USE_ATTRIBUTE,
    y2: MUST_USE_ATTRIBUTE,
    y: MUST_USE_ATTRIBUTE
  },
  DOMAttributeNames: {
    fillOpacity: 'fill-opacity',
    fontFamily: 'font-family',
    fontSize: 'font-size',
    gradientTransform: 'gradientTransform',
    gradientUnits: 'gradientUnits',
    markerEnd: 'marker-end',
    markerMid: 'marker-mid',
    markerStart: 'marker-start',
    patternContentUnits: 'patternContentUnits',
    patternUnits: 'patternUnits',
    preserveAspectRatio: 'preserveAspectRatio',
    spreadMethod: 'spreadMethod',
    stopColor: 'stop-color',
    stopOpacity: 'stop-opacity',
    strokeDasharray: 'stroke-dasharray',
    strokeLinecap: 'stroke-linecap',
    strokeOpacity: 'stroke-opacity',
    strokeWidth: 'stroke-width',
    textAnchor: 'text-anchor',
    viewBox: 'viewBox'
  }
};

module.exports = SVGDOMPropertyConfig;

},{"./DOMProperty":10}],81:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SelectEventPlugin
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPropagators = require("./EventPropagators");
var ReactInputSelection = require("./ReactInputSelection");
var SyntheticEvent = require("./SyntheticEvent");

var getActiveElement = require("./getActiveElement");
var isTextInputElement = require("./isTextInputElement");
var keyOf = require("./keyOf");
var shallowEqual = require("./shallowEqual");

var topLevelTypes = EventConstants.topLevelTypes;

var eventTypes = {
  select: {
    phasedRegistrationNames: {
      bubbled: keyOf({onSelect: null}),
      captured: keyOf({onSelectCapture: null})
    },
    dependencies: [
      topLevelTypes.topBlur,
      topLevelTypes.topContextMenu,
      topLevelTypes.topFocus,
      topLevelTypes.topKeyDown,
      topLevelTypes.topMouseDown,
      topLevelTypes.topMouseUp,
      topLevelTypes.topSelectionChange
    ]
  }
};

var activeElement = null;
var activeElementID = null;
var lastSelection = null;
var mouseDown = false;

/**
 * Get an object which is a unique representation of the current selection.
 *
 * The return value will not be consistent across nodes or browsers, but
 * two identical selections on the same node will return identical objects.
 *
 * @param {DOMElement} node
 * @param {object}
 */
function getSelection(node) {
  if ('selectionStart' in node &&
      ReactInputSelection.hasSelectionCapabilities(node)) {
    return {
      start: node.selectionStart,
      end: node.selectionEnd
    };
  } else if (window.getSelection) {
    var selection = window.getSelection();
    return {
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset
    };
  } else if (document.selection) {
    var range = document.selection.createRange();
    return {
      parentElement: range.parentElement(),
      text: range.text,
      top: range.boundingTop,
      left: range.boundingLeft
    };
  }
}

/**
 * Poll selection to see whether it's changed.
 *
 * @param {object} nativeEvent
 * @return {?SyntheticEvent}
 */
function constructSelectEvent(nativeEvent) {
  // Ensure we have the right element, and that the user is not dragging a
  // selection (this matches native `select` event behavior). In HTML5, select
  // fires only on input and textarea thus if there's no focused element we
  // won't dispatch.
  if (mouseDown ||
      activeElement == null ||
      activeElement != getActiveElement()) {
    return;
  }

  // Only fire when selection has actually changed.
  var currentSelection = getSelection(activeElement);
  if (!lastSelection || !shallowEqual(lastSelection, currentSelection)) {
    lastSelection = currentSelection;

    var syntheticEvent = SyntheticEvent.getPooled(
      eventTypes.select,
      activeElementID,
      nativeEvent
    );

    syntheticEvent.type = 'select';
    syntheticEvent.target = activeElement;

    EventPropagators.accumulateTwoPhaseDispatches(syntheticEvent);

    return syntheticEvent;
  }
}

/**
 * This plugin creates an `onSelect` event that normalizes select events
 * across form elements.
 *
 * Supported elements are:
 * - input (see `isTextInputElement`)
 * - textarea
 * - contentEditable
 *
 * This differs from native browser implementations in the following ways:
 * - Fires on contentEditable fields as well as inputs.
 * - Fires for collapsed selection.
 * - Fires after user input.
 */
var SelectEventPlugin = {

  eventTypes: eventTypes,

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {

    switch (topLevelType) {
      // Track the input node that has focus.
      case topLevelTypes.topFocus:
        if (isTextInputElement(topLevelTarget) ||
            topLevelTarget.contentEditable === 'true') {
          activeElement = topLevelTarget;
          activeElementID = topLevelTargetID;
          lastSelection = null;
        }
        break;
      case topLevelTypes.topBlur:
        activeElement = null;
        activeElementID = null;
        lastSelection = null;
        break;

      // Don't fire the event while the user is dragging. This matches the
      // semantics of the native select event.
      case topLevelTypes.topMouseDown:
        mouseDown = true;
        break;
      case topLevelTypes.topContextMenu:
      case topLevelTypes.topMouseUp:
        mouseDown = false;
        return constructSelectEvent(nativeEvent);

      // Chrome and IE fire non-standard event when selection is changed (and
      // sometimes when it hasn't).
      // Firefox doesn't support selectionchange, so check selection status
      // after each key entry. The selection changes after keydown and before
      // keyup, but we check on keydown as well in the case of holding down a
      // key, when multiple keydown events are fired but only one keyup is.
      case topLevelTypes.topSelectionChange:
      case topLevelTypes.topKeyDown:
      case topLevelTypes.topKeyUp:
        return constructSelectEvent(nativeEvent);
    }
  }
};

module.exports = SelectEventPlugin;

},{"./EventConstants":15,"./EventPropagators":20,"./ReactInputSelection":59,"./SyntheticEvent":87,"./getActiveElement":113,"./isTextInputElement":129,"./keyOf":133,"./shallowEqual":141}],82:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ServerReactRootIndex
 * @typechecks
 */

"use strict";

/**
 * Size of the reactRoot ID space. We generate random numbers for React root
 * IDs and if there's a collision the events and DOM update system will
 * get confused. In the future we need a way to generate GUIDs but for
 * now this will work on a smaller scale.
 */
var GLOBAL_MOUNT_POINT_MAX = Math.pow(2, 53);

var ServerReactRootIndex = {
  createReactRootIndex: function() {
    return Math.ceil(Math.random() * GLOBAL_MOUNT_POINT_MAX);
  }
};

module.exports = ServerReactRootIndex;

},{}],83:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SimpleEventPlugin
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPluginUtils = require("./EventPluginUtils");
var EventPropagators = require("./EventPropagators");
var SyntheticClipboardEvent = require("./SyntheticClipboardEvent");
var SyntheticEvent = require("./SyntheticEvent");
var SyntheticFocusEvent = require("./SyntheticFocusEvent");
var SyntheticKeyboardEvent = require("./SyntheticKeyboardEvent");
var SyntheticMouseEvent = require("./SyntheticMouseEvent");
var SyntheticDragEvent = require("./SyntheticDragEvent");
var SyntheticTouchEvent = require("./SyntheticTouchEvent");
var SyntheticUIEvent = require("./SyntheticUIEvent");
var SyntheticWheelEvent = require("./SyntheticWheelEvent");

var getEventCharCode = require("./getEventCharCode");

var invariant = require("./invariant");
var keyOf = require("./keyOf");
var warning = require("./warning");

var topLevelTypes = EventConstants.topLevelTypes;

var eventTypes = {
  blur: {
    phasedRegistrationNames: {
      bubbled: keyOf({onBlur: true}),
      captured: keyOf({onBlurCapture: true})
    }
  },
  click: {
    phasedRegistrationNames: {
      bubbled: keyOf({onClick: true}),
      captured: keyOf({onClickCapture: true})
    }
  },
  contextMenu: {
    phasedRegistrationNames: {
      bubbled: keyOf({onContextMenu: true}),
      captured: keyOf({onContextMenuCapture: true})
    }
  },
  copy: {
    phasedRegistrationNames: {
      bubbled: keyOf({onCopy: true}),
      captured: keyOf({onCopyCapture: true})
    }
  },
  cut: {
    phasedRegistrationNames: {
      bubbled: keyOf({onCut: true}),
      captured: keyOf({onCutCapture: true})
    }
  },
  doubleClick: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDoubleClick: true}),
      captured: keyOf({onDoubleClickCapture: true})
    }
  },
  drag: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDrag: true}),
      captured: keyOf({onDragCapture: true})
    }
  },
  dragEnd: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragEnd: true}),
      captured: keyOf({onDragEndCapture: true})
    }
  },
  dragEnter: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragEnter: true}),
      captured: keyOf({onDragEnterCapture: true})
    }
  },
  dragExit: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragExit: true}),
      captured: keyOf({onDragExitCapture: true})
    }
  },
  dragLeave: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragLeave: true}),
      captured: keyOf({onDragLeaveCapture: true})
    }
  },
  dragOver: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragOver: true}),
      captured: keyOf({onDragOverCapture: true})
    }
  },
  dragStart: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragStart: true}),
      captured: keyOf({onDragStartCapture: true})
    }
  },
  drop: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDrop: true}),
      captured: keyOf({onDropCapture: true})
    }
  },
  focus: {
    phasedRegistrationNames: {
      bubbled: keyOf({onFocus: true}),
      captured: keyOf({onFocusCapture: true})
    }
  },
  input: {
    phasedRegistrationNames: {
      bubbled: keyOf({onInput: true}),
      captured: keyOf({onInputCapture: true})
    }
  },
  keyDown: {
    phasedRegistrationNames: {
      bubbled: keyOf({onKeyDown: true}),
      captured: keyOf({onKeyDownCapture: true})
    }
  },
  keyPress: {
    phasedRegistrationNames: {
      bubbled: keyOf({onKeyPress: true}),
      captured: keyOf({onKeyPressCapture: true})
    }
  },
  keyUp: {
    phasedRegistrationNames: {
      bubbled: keyOf({onKeyUp: true}),
      captured: keyOf({onKeyUpCapture: true})
    }
  },
  load: {
    phasedRegistrationNames: {
      bubbled: keyOf({onLoad: true}),
      captured: keyOf({onLoadCapture: true})
    }
  },
  error: {
    phasedRegistrationNames: {
      bubbled: keyOf({onError: true}),
      captured: keyOf({onErrorCapture: true})
    }
  },
  // Note: We do not allow listening to mouseOver events. Instead, use the
  // onMouseEnter/onMouseLeave created by `EnterLeaveEventPlugin`.
  mouseDown: {
    phasedRegistrationNames: {
      bubbled: keyOf({onMouseDown: true}),
      captured: keyOf({onMouseDownCapture: true})
    }
  },
  mouseMove: {
    phasedRegistrationNames: {
      bubbled: keyOf({onMouseMove: true}),
      captured: keyOf({onMouseMoveCapture: true})
    }
  },
  mouseOut: {
    phasedRegistrationNames: {
      bubbled: keyOf({onMouseOut: true}),
      captured: keyOf({onMouseOutCapture: true})
    }
  },
  mouseOver: {
    phasedRegistrationNames: {
      bubbled: keyOf({onMouseOver: true}),
      captured: keyOf({onMouseOverCapture: true})
    }
  },
  mouseUp: {
    phasedRegistrationNames: {
      bubbled: keyOf({onMouseUp: true}),
      captured: keyOf({onMouseUpCapture: true})
    }
  },
  paste: {
    phasedRegistrationNames: {
      bubbled: keyOf({onPaste: true}),
      captured: keyOf({onPasteCapture: true})
    }
  },
  reset: {
    phasedRegistrationNames: {
      bubbled: keyOf({onReset: true}),
      captured: keyOf({onResetCapture: true})
    }
  },
  scroll: {
    phasedRegistrationNames: {
      bubbled: keyOf({onScroll: true}),
      captured: keyOf({onScrollCapture: true})
    }
  },
  submit: {
    phasedRegistrationNames: {
      bubbled: keyOf({onSubmit: true}),
      captured: keyOf({onSubmitCapture: true})
    }
  },
  touchCancel: {
    phasedRegistrationNames: {
      bubbled: keyOf({onTouchCancel: true}),
      captured: keyOf({onTouchCancelCapture: true})
    }
  },
  touchEnd: {
    phasedRegistrationNames: {
      bubbled: keyOf({onTouchEnd: true}),
      captured: keyOf({onTouchEndCapture: true})
    }
  },
  touchMove: {
    phasedRegistrationNames: {
      bubbled: keyOf({onTouchMove: true}),
      captured: keyOf({onTouchMoveCapture: true})
    }
  },
  touchStart: {
    phasedRegistrationNames: {
      bubbled: keyOf({onTouchStart: true}),
      captured: keyOf({onTouchStartCapture: true})
    }
  },
  wheel: {
    phasedRegistrationNames: {
      bubbled: keyOf({onWheel: true}),
      captured: keyOf({onWheelCapture: true})
    }
  }
};

var topLevelEventsToDispatchConfig = {
  topBlur:        eventTypes.blur,
  topClick:       eventTypes.click,
  topContextMenu: eventTypes.contextMenu,
  topCopy:        eventTypes.copy,
  topCut:         eventTypes.cut,
  topDoubleClick: eventTypes.doubleClick,
  topDrag:        eventTypes.drag,
  topDragEnd:     eventTypes.dragEnd,
  topDragEnter:   eventTypes.dragEnter,
  topDragExit:    eventTypes.dragExit,
  topDragLeave:   eventTypes.dragLeave,
  topDragOver:    eventTypes.dragOver,
  topDragStart:   eventTypes.dragStart,
  topDrop:        eventTypes.drop,
  topError:       eventTypes.error,
  topFocus:       eventTypes.focus,
  topInput:       eventTypes.input,
  topKeyDown:     eventTypes.keyDown,
  topKeyPress:    eventTypes.keyPress,
  topKeyUp:       eventTypes.keyUp,
  topLoad:        eventTypes.load,
  topMouseDown:   eventTypes.mouseDown,
  topMouseMove:   eventTypes.mouseMove,
  topMouseOut:    eventTypes.mouseOut,
  topMouseOver:   eventTypes.mouseOver,
  topMouseUp:     eventTypes.mouseUp,
  topPaste:       eventTypes.paste,
  topReset:       eventTypes.reset,
  topScroll:      eventTypes.scroll,
  topSubmit:      eventTypes.submit,
  topTouchCancel: eventTypes.touchCancel,
  topTouchEnd:    eventTypes.touchEnd,
  topTouchMove:   eventTypes.touchMove,
  topTouchStart:  eventTypes.touchStart,
  topWheel:       eventTypes.wheel
};

for (var topLevelType in topLevelEventsToDispatchConfig) {
  topLevelEventsToDispatchConfig[topLevelType].dependencies = [topLevelType];
}

var SimpleEventPlugin = {

  eventTypes: eventTypes,

  /**
   * Same as the default implementation, except cancels the event when return
   * value is false. This behavior will be disabled in a future release.
   *
   * @param {object} Event to be dispatched.
   * @param {function} Application-level callback.
   * @param {string} domID DOM ID to pass to the callback.
   */
  executeDispatch: function(event, listener, domID) {
    var returnValue = EventPluginUtils.executeDispatch(event, listener, domID);

    ("production" !== process.env.NODE_ENV ? warning(
      typeof returnValue !== 'boolean',
      'Returning `false` from an event handler is deprecated and will be ' +
      'ignored in a future release. Instead, manually call ' +
      'e.stopPropagation() or e.preventDefault(), as appropriate.'
    ) : null);

    if (returnValue === false) {
      event.stopPropagation();
      event.preventDefault();
    }
  },

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {
    var dispatchConfig = topLevelEventsToDispatchConfig[topLevelType];
    if (!dispatchConfig) {
      return null;
    }
    var EventConstructor;
    switch (topLevelType) {
      case topLevelTypes.topInput:
      case topLevelTypes.topLoad:
      case topLevelTypes.topError:
      case topLevelTypes.topReset:
      case topLevelTypes.topSubmit:
        // HTML Events
        // @see http://www.w3.org/TR/html5/index.html#events-0
        EventConstructor = SyntheticEvent;
        break;
      case topLevelTypes.topKeyPress:
        // FireFox creates a keypress event for function keys too. This removes
        // the unwanted keypress events. Enter is however both printable and
        // non-printable. One would expect Tab to be as well (but it isn't).
        if (getEventCharCode(nativeEvent) === 0) {
          return null;
        }
        /* falls through */
      case topLevelTypes.topKeyDown:
      case topLevelTypes.topKeyUp:
        EventConstructor = SyntheticKeyboardEvent;
        break;
      case topLevelTypes.topBlur:
      case topLevelTypes.topFocus:
        EventConstructor = SyntheticFocusEvent;
        break;
      case topLevelTypes.topClick:
        // Firefox creates a click event on right mouse clicks. This removes the
        // unwanted click events.
        if (nativeEvent.button === 2) {
          return null;
        }
        /* falls through */
      case topLevelTypes.topContextMenu:
      case topLevelTypes.topDoubleClick:
      case topLevelTypes.topMouseDown:
      case topLevelTypes.topMouseMove:
      case topLevelTypes.topMouseOut:
      case topLevelTypes.topMouseOver:
      case topLevelTypes.topMouseUp:
        EventConstructor = SyntheticMouseEvent;
        break;
      case topLevelTypes.topDrag:
      case topLevelTypes.topDragEnd:
      case topLevelTypes.topDragEnter:
      case topLevelTypes.topDragExit:
      case topLevelTypes.topDragLeave:
      case topLevelTypes.topDragOver:
      case topLevelTypes.topDragStart:
      case topLevelTypes.topDrop:
        EventConstructor = SyntheticDragEvent;
        break;
      case topLevelTypes.topTouchCancel:
      case topLevelTypes.topTouchEnd:
      case topLevelTypes.topTouchMove:
      case topLevelTypes.topTouchStart:
        EventConstructor = SyntheticTouchEvent;
        break;
      case topLevelTypes.topScroll:
        EventConstructor = SyntheticUIEvent;
        break;
      case topLevelTypes.topWheel:
        EventConstructor = SyntheticWheelEvent;
        break;
      case topLevelTypes.topCopy:
      case topLevelTypes.topCut:
      case topLevelTypes.topPaste:
        EventConstructor = SyntheticClipboardEvent;
        break;
    }
    ("production" !== process.env.NODE_ENV ? invariant(
      EventConstructor,
      'SimpleEventPlugin: Unhandled event type, `%s`.',
      topLevelType
    ) : invariant(EventConstructor));
    var event = EventConstructor.getPooled(
      dispatchConfig,
      topLevelTargetID,
      nativeEvent
    );
    EventPropagators.accumulateTwoPhaseDispatches(event);
    return event;
  }

};

module.exports = SimpleEventPlugin;

}).call(this,require('_process'))
},{"./EventConstants":15,"./EventPluginUtils":19,"./EventPropagators":20,"./SyntheticClipboardEvent":84,"./SyntheticDragEvent":86,"./SyntheticEvent":87,"./SyntheticFocusEvent":88,"./SyntheticKeyboardEvent":90,"./SyntheticMouseEvent":91,"./SyntheticTouchEvent":92,"./SyntheticUIEvent":93,"./SyntheticWheelEvent":94,"./getEventCharCode":114,"./invariant":126,"./keyOf":133,"./warning":145,"_process":152}],84:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticClipboardEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticEvent = require("./SyntheticEvent");

/**
 * @interface Event
 * @see http://www.w3.org/TR/clipboard-apis/
 */
var ClipboardEventInterface = {
  clipboardData: function(event) {
    return (
      'clipboardData' in event ?
        event.clipboardData :
        window.clipboardData
    );
  }
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticClipboardEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticEvent.augmentClass(SyntheticClipboardEvent, ClipboardEventInterface);

module.exports = SyntheticClipboardEvent;


},{"./SyntheticEvent":87}],85:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticCompositionEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticEvent = require("./SyntheticEvent");

/**
 * @interface Event
 * @see http://www.w3.org/TR/DOM-Level-3-Events/#events-compositionevents
 */
var CompositionEventInterface = {
  data: null
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticCompositionEvent(
  dispatchConfig,
  dispatchMarker,
  nativeEvent) {
  SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticEvent.augmentClass(
  SyntheticCompositionEvent,
  CompositionEventInterface
);

module.exports = SyntheticCompositionEvent;


},{"./SyntheticEvent":87}],86:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticDragEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticMouseEvent = require("./SyntheticMouseEvent");

/**
 * @interface DragEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var DragEventInterface = {
  dataTransfer: null
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticDragEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticMouseEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticMouseEvent.augmentClass(SyntheticDragEvent, DragEventInterface);

module.exports = SyntheticDragEvent;

},{"./SyntheticMouseEvent":91}],87:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticEvent
 * @typechecks static-only
 */

"use strict";

var PooledClass = require("./PooledClass");

var assign = require("./Object.assign");
var emptyFunction = require("./emptyFunction");
var getEventTarget = require("./getEventTarget");

/**
 * @interface Event
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var EventInterface = {
  type: null,
  target: getEventTarget,
  // currentTarget is set when dispatching; no use in copying it here
  currentTarget: emptyFunction.thatReturnsNull,
  eventPhase: null,
  bubbles: null,
  cancelable: null,
  timeStamp: function(event) {
    return event.timeStamp || Date.now();
  },
  defaultPrevented: null,
  isTrusted: null
};

/**
 * Synthetic events are dispatched by event plugins, typically in response to a
 * top-level event delegation handler.
 *
 * These systems should generally use pooling to reduce the frequency of garbage
 * collection. The system should check `isPersistent` to determine whether the
 * event should be released into the pool after being dispatched. Users that
 * need a persisted event should invoke `persist`.
 *
 * Synthetic events (and subclasses) implement the DOM Level 3 Events API by
 * normalizing browser quirks. Subclasses do not necessarily have to implement a
 * DOM interface; custom application-specific events can also subclass this.
 *
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 */
function SyntheticEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  this.dispatchConfig = dispatchConfig;
  this.dispatchMarker = dispatchMarker;
  this.nativeEvent = nativeEvent;

  var Interface = this.constructor.Interface;
  for (var propName in Interface) {
    if (!Interface.hasOwnProperty(propName)) {
      continue;
    }
    var normalize = Interface[propName];
    if (normalize) {
      this[propName] = normalize(nativeEvent);
    } else {
      this[propName] = nativeEvent[propName];
    }
  }

  var defaultPrevented = nativeEvent.defaultPrevented != null ?
    nativeEvent.defaultPrevented :
    nativeEvent.returnValue === false;
  if (defaultPrevented) {
    this.isDefaultPrevented = emptyFunction.thatReturnsTrue;
  } else {
    this.isDefaultPrevented = emptyFunction.thatReturnsFalse;
  }
  this.isPropagationStopped = emptyFunction.thatReturnsFalse;
}

assign(SyntheticEvent.prototype, {

  preventDefault: function() {
    this.defaultPrevented = true;
    var event = this.nativeEvent;
    event.preventDefault ? event.preventDefault() : event.returnValue = false;
    this.isDefaultPrevented = emptyFunction.thatReturnsTrue;
  },

  stopPropagation: function() {
    var event = this.nativeEvent;
    event.stopPropagation ? event.stopPropagation() : event.cancelBubble = true;
    this.isPropagationStopped = emptyFunction.thatReturnsTrue;
  },

  /**
   * We release all dispatched `SyntheticEvent`s after each event loop, adding
   * them back into the pool. This allows a way to hold onto a reference that
   * won't be added back into the pool.
   */
  persist: function() {
    this.isPersistent = emptyFunction.thatReturnsTrue;
  },

  /**
   * Checks if this event should be released back into the pool.
   *
   * @return {boolean} True if this should not be released, false otherwise.
   */
  isPersistent: emptyFunction.thatReturnsFalse,

  /**
   * `PooledClass` looks for `destructor` on each instance it releases.
   */
  destructor: function() {
    var Interface = this.constructor.Interface;
    for (var propName in Interface) {
      this[propName] = null;
    }
    this.dispatchConfig = null;
    this.dispatchMarker = null;
    this.nativeEvent = null;
  }

});

SyntheticEvent.Interface = EventInterface;

/**
 * Helper to reduce boilerplate when creating subclasses.
 *
 * @param {function} Class
 * @param {?object} Interface
 */
SyntheticEvent.augmentClass = function(Class, Interface) {
  var Super = this;

  var prototype = Object.create(Super.prototype);
  assign(prototype, Class.prototype);
  Class.prototype = prototype;
  Class.prototype.constructor = Class;

  Class.Interface = assign({}, Super.Interface, Interface);
  Class.augmentClass = Super.augmentClass;

  PooledClass.addPoolingTo(Class, PooledClass.threeArgumentPooler);
};

PooledClass.addPoolingTo(SyntheticEvent, PooledClass.threeArgumentPooler);

module.exports = SyntheticEvent;

},{"./Object.assign":26,"./PooledClass":27,"./emptyFunction":107,"./getEventTarget":117}],88:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticFocusEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticUIEvent = require("./SyntheticUIEvent");

/**
 * @interface FocusEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var FocusEventInterface = {
  relatedTarget: null
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticFocusEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticUIEvent.augmentClass(SyntheticFocusEvent, FocusEventInterface);

module.exports = SyntheticFocusEvent;

},{"./SyntheticUIEvent":93}],89:[function(require,module,exports){
/**
 * Copyright 2013 Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticInputEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticEvent = require("./SyntheticEvent");

/**
 * @interface Event
 * @see http://www.w3.org/TR/2013/WD-DOM-Level-3-Events-20131105
 *      /#events-inputevents
 */
var InputEventInterface = {
  data: null
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticInputEvent(
  dispatchConfig,
  dispatchMarker,
  nativeEvent) {
  SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticEvent.augmentClass(
  SyntheticInputEvent,
  InputEventInterface
);

module.exports = SyntheticInputEvent;


},{"./SyntheticEvent":87}],90:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticKeyboardEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticUIEvent = require("./SyntheticUIEvent");

var getEventCharCode = require("./getEventCharCode");
var getEventKey = require("./getEventKey");
var getEventModifierState = require("./getEventModifierState");

/**
 * @interface KeyboardEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var KeyboardEventInterface = {
  key: getEventKey,
  location: null,
  ctrlKey: null,
  shiftKey: null,
  altKey: null,
  metaKey: null,
  repeat: null,
  locale: null,
  getModifierState: getEventModifierState,
  // Legacy Interface
  charCode: function(event) {
    // `charCode` is the result of a KeyPress event and represents the value of
    // the actual printable character.

    // KeyPress is deprecated, but its replacement is not yet final and not
    // implemented in any major browser. Only KeyPress has charCode.
    if (event.type === 'keypress') {
      return getEventCharCode(event);
    }
    return 0;
  },
  keyCode: function(event) {
    // `keyCode` is the result of a KeyDown/Up event and represents the value of
    // physical keyboard key.

    // The actual meaning of the value depends on the users' keyboard layout
    // which cannot be detected. Assuming that it is a US keyboard layout
    // provides a surprisingly accurate mapping for US and European users.
    // Due to this, it is left to the user to implement at this time.
    if (event.type === 'keydown' || event.type === 'keyup') {
      return event.keyCode;
    }
    return 0;
  },
  which: function(event) {
    // `which` is an alias for either `keyCode` or `charCode` depending on the
    // type of the event.
    if (event.type === 'keypress') {
      return getEventCharCode(event);
    }
    if (event.type === 'keydown' || event.type === 'keyup') {
      return event.keyCode;
    }
    return 0;
  }
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticKeyboardEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticUIEvent.augmentClass(SyntheticKeyboardEvent, KeyboardEventInterface);

module.exports = SyntheticKeyboardEvent;

},{"./SyntheticUIEvent":93,"./getEventCharCode":114,"./getEventKey":115,"./getEventModifierState":116}],91:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticMouseEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticUIEvent = require("./SyntheticUIEvent");
var ViewportMetrics = require("./ViewportMetrics");

var getEventModifierState = require("./getEventModifierState");

/**
 * @interface MouseEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var MouseEventInterface = {
  screenX: null,
  screenY: null,
  clientX: null,
  clientY: null,
  ctrlKey: null,
  shiftKey: null,
  altKey: null,
  metaKey: null,
  getModifierState: getEventModifierState,
  button: function(event) {
    // Webkit, Firefox, IE9+
    // which:  1 2 3
    // button: 0 1 2 (standard)
    var button = event.button;
    if ('which' in event) {
      return button;
    }
    // IE<9
    // which:  undefined
    // button: 0 0 0
    // button: 1 4 2 (onmouseup)
    return button === 2 ? 2 : button === 4 ? 1 : 0;
  },
  buttons: null,
  relatedTarget: function(event) {
    return event.relatedTarget || (
      event.fromElement === event.srcElement ?
        event.toElement :
        event.fromElement
    );
  },
  // "Proprietary" Interface.
  pageX: function(event) {
    return 'pageX' in event ?
      event.pageX :
      event.clientX + ViewportMetrics.currentScrollLeft;
  },
  pageY: function(event) {
    return 'pageY' in event ?
      event.pageY :
      event.clientY + ViewportMetrics.currentScrollTop;
  }
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticMouseEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticUIEvent.augmentClass(SyntheticMouseEvent, MouseEventInterface);

module.exports = SyntheticMouseEvent;

},{"./SyntheticUIEvent":93,"./ViewportMetrics":96,"./getEventModifierState":116}],92:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticTouchEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticUIEvent = require("./SyntheticUIEvent");

var getEventModifierState = require("./getEventModifierState");

/**
 * @interface TouchEvent
 * @see http://www.w3.org/TR/touch-events/
 */
var TouchEventInterface = {
  touches: null,
  targetTouches: null,
  changedTouches: null,
  altKey: null,
  metaKey: null,
  ctrlKey: null,
  shiftKey: null,
  getModifierState: getEventModifierState
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticTouchEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticUIEvent.augmentClass(SyntheticTouchEvent, TouchEventInterface);

module.exports = SyntheticTouchEvent;

},{"./SyntheticUIEvent":93,"./getEventModifierState":116}],93:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticUIEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticEvent = require("./SyntheticEvent");

var getEventTarget = require("./getEventTarget");

/**
 * @interface UIEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var UIEventInterface = {
  view: function(event) {
    if (event.view) {
      return event.view;
    }

    var target = getEventTarget(event);
    if (target != null && target.window === target) {
      // target is a window object
      return target;
    }

    var doc = target.ownerDocument;
    // TODO: Figure out why `ownerDocument` is sometimes undefined in IE8.
    if (doc) {
      return doc.defaultView || doc.parentWindow;
    } else {
      return window;
    }
  },
  detail: function(event) {
    return event.detail || 0;
  }
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticEvent}
 */
function SyntheticUIEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticEvent.augmentClass(SyntheticUIEvent, UIEventInterface);

module.exports = SyntheticUIEvent;

},{"./SyntheticEvent":87,"./getEventTarget":117}],94:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticWheelEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticMouseEvent = require("./SyntheticMouseEvent");

/**
 * @interface WheelEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var WheelEventInterface = {
  deltaX: function(event) {
    return (
      'deltaX' in event ? event.deltaX :
      // Fallback to `wheelDeltaX` for Webkit and normalize (right is positive).
      'wheelDeltaX' in event ? -event.wheelDeltaX : 0
    );
  },
  deltaY: function(event) {
    return (
      'deltaY' in event ? event.deltaY :
      // Fallback to `wheelDeltaY` for Webkit and normalize (down is positive).
      'wheelDeltaY' in event ? -event.wheelDeltaY :
      // Fallback to `wheelDelta` for IE<9 and normalize (down is positive).
      'wheelDelta' in event ? -event.wheelDelta : 0
    );
  },
  deltaZ: null,

  // Browsers without "deltaMode" is reporting in raw wheel delta where one
  // notch on the scroll is always +/- 120, roughly equivalent to pixels.
  // A good approximation of DOM_DELTA_LINE (1) is 5% of viewport size or
  // ~40 pixels, for DOM_DELTA_SCREEN (2) it is 87.5% of viewport size.
  deltaMode: null
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticMouseEvent}
 */
function SyntheticWheelEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticMouseEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticMouseEvent.augmentClass(SyntheticWheelEvent, WheelEventInterface);

module.exports = SyntheticWheelEvent;

},{"./SyntheticMouseEvent":91}],95:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule Transaction
 */

"use strict";

var invariant = require("./invariant");

/**
 * `Transaction` creates a black box that is able to wrap any method such that
 * certain invariants are maintained before and after the method is invoked
 * (Even if an exception is thrown while invoking the wrapped method). Whoever
 * instantiates a transaction can provide enforcers of the invariants at
 * creation time. The `Transaction` class itself will supply one additional
 * automatic invariant for you - the invariant that any transaction instance
 * should not be run while it is already being run. You would typically create a
 * single instance of a `Transaction` for reuse multiple times, that potentially
 * is used to wrap several different methods. Wrappers are extremely simple -
 * they only require implementing two methods.
 *
 * <pre>
 *                       wrappers (injected at creation time)
 *                                      +        +
 *                                      |        |
 *                    +-----------------|--------|--------------+
 *                    |                 v        |              |
 *                    |      +---------------+   |              |
 *                    |   +--|    wrapper1   |---|----+         |
 *                    |   |  +---------------+   v    |         |
 *                    |   |          +-------------+  |         |
 *                    |   |     +----|   wrapper2  |--------+   |
 *                    |   |     |    +-------------+  |     |   |
 *                    |   |     |                     |     |   |
 *                    |   v     v                     v     v   | wrapper
 *                    | +---+ +---+   +---------+   +---+ +---+ | invariants
 * perform(anyMethod) | |   | |   |   |         |   |   | |   | | maintained
 * +----------------->|-|---|-|---|-->|anyMethod|---|---|-|---|-|-------->
 *                    | |   | |   |   |         |   |   | |   | |
 *                    | |   | |   |   |         |   |   | |   | |
 *                    | |   | |   |   |         |   |   | |   | |
 *                    | +---+ +---+   +---------+   +---+ +---+ |
 *                    |  initialize                    close    |
 *                    +-----------------------------------------+
 * </pre>
 *
 * Use cases:
 * - Preserving the input selection ranges before/after reconciliation.
 *   Restoring selection even in the event of an unexpected error.
 * - Deactivating events while rearranging the DOM, preventing blurs/focuses,
 *   while guaranteeing that afterwards, the event system is reactivated.
 * - Flushing a queue of collected DOM mutations to the main UI thread after a
 *   reconciliation takes place in a worker thread.
 * - Invoking any collected `componentDidUpdate` callbacks after rendering new
 *   content.
 * - (Future use case): Wrapping particular flushes of the `ReactWorker` queue
 *   to preserve the `scrollTop` (an automatic scroll aware DOM).
 * - (Future use case): Layout calculations before and after DOM upates.
 *
 * Transactional plugin API:
 * - A module that has an `initialize` method that returns any precomputation.
 * - and a `close` method that accepts the precomputation. `close` is invoked
 *   when the wrapped process is completed, or has failed.
 *
 * @param {Array<TransactionalWrapper>} transactionWrapper Wrapper modules
 * that implement `initialize` and `close`.
 * @return {Transaction} Single transaction for reuse in thread.
 *
 * @class Transaction
 */
var Mixin = {
  /**
   * Sets up this instance so that it is prepared for collecting metrics. Does
   * so such that this setup method may be used on an instance that is already
   * initialized, in a way that does not consume additional memory upon reuse.
   * That can be useful if you decide to make your subclass of this mixin a
   * "PooledClass".
   */
  reinitializeTransaction: function() {
    this.transactionWrappers = this.getTransactionWrappers();
    if (!this.wrapperInitData) {
      this.wrapperInitData = [];
    } else {
      this.wrapperInitData.length = 0;
    }
    this._isInTransaction = false;
  },

  _isInTransaction: false,

  /**
   * @abstract
   * @return {Array<TransactionWrapper>} Array of transaction wrappers.
   */
  getTransactionWrappers: null,

  isInTransaction: function() {
    return !!this._isInTransaction;
  },

  /**
   * Executes the function within a safety window. Use this for the top level
   * methods that result in large amounts of computation/mutations that would
   * need to be safety checked.
   *
   * @param {function} method Member of scope to call.
   * @param {Object} scope Scope to invoke from.
   * @param {Object?=} args... Arguments to pass to the method (optional).
   *                           Helps prevent need to bind in many cases.
   * @return Return value from `method`.
   */
  perform: function(method, scope, a, b, c, d, e, f) {
    ("production" !== process.env.NODE_ENV ? invariant(
      !this.isInTransaction(),
      'Transaction.perform(...): Cannot initialize a transaction when there ' +
      'is already an outstanding transaction.'
    ) : invariant(!this.isInTransaction()));
    var errorThrown;
    var ret;
    try {
      this._isInTransaction = true;
      // Catching errors makes debugging more difficult, so we start with
      // errorThrown set to true before setting it to false after calling
      // close -- if it's still set to true in the finally block, it means
      // one of these calls threw.
      errorThrown = true;
      this.initializeAll(0);
      ret = method.call(scope, a, b, c, d, e, f);
      errorThrown = false;
    } finally {
      try {
        if (errorThrown) {
          // If `method` throws, prefer to show that stack trace over any thrown
          // by invoking `closeAll`.
          try {
            this.closeAll(0);
          } catch (err) {
          }
        } else {
          // Since `method` didn't throw, we don't want to silence the exception
          // here.
          this.closeAll(0);
        }
      } finally {
        this._isInTransaction = false;
      }
    }
    return ret;
  },

  initializeAll: function(startIndex) {
    var transactionWrappers = this.transactionWrappers;
    for (var i = startIndex; i < transactionWrappers.length; i++) {
      var wrapper = transactionWrappers[i];
      try {
        // Catching errors makes debugging more difficult, so we start with the
        // OBSERVED_ERROR state before overwriting it with the real return value
        // of initialize -- if it's still set to OBSERVED_ERROR in the finally
        // block, it means wrapper.initialize threw.
        this.wrapperInitData[i] = Transaction.OBSERVED_ERROR;
        this.wrapperInitData[i] = wrapper.initialize ?
          wrapper.initialize.call(this) :
          null;
      } finally {
        if (this.wrapperInitData[i] === Transaction.OBSERVED_ERROR) {
          // The initializer for wrapper i threw an error; initialize the
          // remaining wrappers but silence any exceptions from them to ensure
          // that the first error is the one to bubble up.
          try {
            this.initializeAll(i + 1);
          } catch (err) {
          }
        }
      }
    }
  },

  /**
   * Invokes each of `this.transactionWrappers.close[i]` functions, passing into
   * them the respective return values of `this.transactionWrappers.init[i]`
   * (`close`rs that correspond to initializers that failed will not be
   * invoked).
   */
  closeAll: function(startIndex) {
    ("production" !== process.env.NODE_ENV ? invariant(
      this.isInTransaction(),
      'Transaction.closeAll(): Cannot close transaction when none are open.'
    ) : invariant(this.isInTransaction()));
    var transactionWrappers = this.transactionWrappers;
    for (var i = startIndex; i < transactionWrappers.length; i++) {
      var wrapper = transactionWrappers[i];
      var initData = this.wrapperInitData[i];
      var errorThrown;
      try {
        // Catching errors makes debugging more difficult, so we start with
        // errorThrown set to true before setting it to false after calling
        // close -- if it's still set to true in the finally block, it means
        // wrapper.close threw.
        errorThrown = true;
        if (initData !== Transaction.OBSERVED_ERROR) {
          wrapper.close && wrapper.close.call(this, initData);
        }
        errorThrown = false;
      } finally {
        if (errorThrown) {
          // The closer for wrapper i threw an error; close the remaining
          // wrappers but silence any exceptions from them to ensure that the
          // first error is the one to bubble up.
          try {
            this.closeAll(i + 1);
          } catch (e) {
          }
        }
      }
    }
    this.wrapperInitData.length = 0;
  }
};

var Transaction = {

  Mixin: Mixin,

  /**
   * Token to look for to determine if an error occured.
   */
  OBSERVED_ERROR: {}

};

module.exports = Transaction;

}).call(this,require('_process'))
},{"./invariant":126,"_process":152}],96:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ViewportMetrics
 */

"use strict";

var getUnboundedScrollPosition = require("./getUnboundedScrollPosition");

var ViewportMetrics = {

  currentScrollLeft: 0,

  currentScrollTop: 0,

  refreshScrollValues: function() {
    var scrollPosition = getUnboundedScrollPosition(window);
    ViewportMetrics.currentScrollLeft = scrollPosition.x;
    ViewportMetrics.currentScrollTop = scrollPosition.y;
  }

};

module.exports = ViewportMetrics;

},{"./getUnboundedScrollPosition":122}],97:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule accumulateInto
 */

"use strict";

var invariant = require("./invariant");

/**
 *
 * Accumulates items that must not be null or undefined into the first one. This
 * is used to conserve memory by avoiding array allocations, and thus sacrifices
 * API cleanness. Since `current` can be null before being passed in and not
 * null after this function, make sure to assign it back to `current`:
 *
 * `a = accumulateInto(a, b);`
 *
 * This API should be sparingly used. Try `accumulate` for something cleaner.
 *
 * @return {*|array<*>} An accumulation of items.
 */

function accumulateInto(current, next) {
  ("production" !== process.env.NODE_ENV ? invariant(
    next != null,
    'accumulateInto(...): Accumulated items must not be null or undefined.'
  ) : invariant(next != null));
  if (current == null) {
    return next;
  }

  // Both are not empty. Warning: Never call x.concat(y) when you are not
  // certain that x is an Array (x could be a string with concat method).
  var currentIsArray = Array.isArray(current);
  var nextIsArray = Array.isArray(next);

  if (currentIsArray && nextIsArray) {
    current.push.apply(current, next);
    return current;
  }

  if (currentIsArray) {
    current.push(next);
    return current;
  }

  if (nextIsArray) {
    // A bit too dangerous to mutate `next`.
    return [current].concat(next);
  }

  return [current, next];
}

module.exports = accumulateInto;

}).call(this,require('_process'))
},{"./invariant":126,"_process":152}],98:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule adler32
 */

/* jslint bitwise:true */

"use strict";

var MOD = 65521;

// This is a clean-room implementation of adler32 designed for detecting
// if markup is not what we expect it to be. It does not need to be
// cryptographically strong, only reasonably good at detecting if markup
// generated on the server is different than that on the client.
function adler32(data) {
  var a = 1;
  var b = 0;
  for (var i = 0; i < data.length; i++) {
    a = (a + data.charCodeAt(i)) % MOD;
    b = (b + a) % MOD;
  }
  return a | (b << 16);
}

module.exports = adler32;

},{}],99:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule camelize
 * @typechecks
 */

var _hyphenPattern = /-(.)/g;

/**
 * Camelcases a hyphenated string, for example:
 *
 *   > camelize('background-color')
 *   < "backgroundColor"
 *
 * @param {string} string
 * @return {string}
 */
function camelize(string) {
  return string.replace(_hyphenPattern, function(_, character) {
    return character.toUpperCase();
  });
}

module.exports = camelize;

},{}],100:[function(require,module,exports){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule camelizeStyleName
 * @typechecks
 */

"use strict";

var camelize = require("./camelize");

var msPattern = /^-ms-/;

/**
 * Camelcases a hyphenated CSS property name, for example:
 *
 *   > camelizeStyleName('background-color')
 *   < "backgroundColor"
 *   > camelizeStyleName('-moz-transition')
 *   < "MozTransition"
 *   > camelizeStyleName('-ms-transition')
 *   < "msTransition"
 *
 * As Andi Smith suggests
 * (http://www.andismith.com/blog/2012/02/modernizr-prefixed/), an `-ms` prefix
 * is converted to lowercase `ms`.
 *
 * @param {string} string
 * @return {string}
 */
function camelizeStyleName(string) {
  return camelize(string.replace(msPattern, 'ms-'));
}

module.exports = camelizeStyleName;

},{"./camelize":99}],101:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule containsNode
 * @typechecks
 */

var isTextNode = require("./isTextNode");

/*jslint bitwise:true */

/**
 * Checks if a given DOM node contains or is another DOM node.
 *
 * @param {?DOMNode} outerNode Outer DOM node.
 * @param {?DOMNode} innerNode Inner DOM node.
 * @return {boolean} True if `outerNode` contains or is `innerNode`.
 */
function containsNode(outerNode, innerNode) {
  if (!outerNode || !innerNode) {
    return false;
  } else if (outerNode === innerNode) {
    return true;
  } else if (isTextNode(outerNode)) {
    return false;
  } else if (isTextNode(innerNode)) {
    return containsNode(outerNode, innerNode.parentNode);
  } else if (outerNode.contains) {
    return outerNode.contains(innerNode);
  } else if (outerNode.compareDocumentPosition) {
    return !!(outerNode.compareDocumentPosition(innerNode) & 16);
  } else {
    return false;
  }
}

module.exports = containsNode;

},{"./isTextNode":130}],102:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule createArrayFrom
 * @typechecks
 */

var toArray = require("./toArray");

/**
 * Perform a heuristic test to determine if an object is "array-like".
 *
 *   A monk asked Joshu, a Zen master, "Has a dog Buddha nature?"
 *   Joshu replied: "Mu."
 *
 * This function determines if its argument has "array nature": it returns
 * true if the argument is an actual array, an `arguments' object, or an
 * HTMLCollection (e.g. node.childNodes or node.getElementsByTagName()).
 *
 * It will return false for other array-like objects like Filelist.
 *
 * @param {*} obj
 * @return {boolean}
 */
function hasArrayNature(obj) {
  return (
    // not null/false
    !!obj &&
    // arrays are objects, NodeLists are functions in Safari
    (typeof obj == 'object' || typeof obj == 'function') &&
    // quacks like an array
    ('length' in obj) &&
    // not window
    !('setInterval' in obj) &&
    // no DOM node should be considered an array-like
    // a 'select' element has 'length' and 'item' properties on IE8
    (typeof obj.nodeType != 'number') &&
    (
      // a real array
      (// HTMLCollection/NodeList
      (Array.isArray(obj) ||
      // arguments
      ('callee' in obj) || 'item' in obj))
    )
  );
}

/**
 * Ensure that the argument is an array by wrapping it in an array if it is not.
 * Creates a copy of the argument if it is already an array.
 *
 * This is mostly useful idiomatically:
 *
 *   var createArrayFrom = require('createArrayFrom');
 *
 *   function takesOneOrMoreThings(things) {
 *     things = createArrayFrom(things);
 *     ...
 *   }
 *
 * This allows you to treat `things' as an array, but accept scalars in the API.
 *
 * If you need to convert an array-like object, like `arguments`, into an array
 * use toArray instead.
 *
 * @param {*} obj
 * @return {array}
 */
function createArrayFrom(obj) {
  if (!hasArrayNature(obj)) {
    return [obj];
  } else if (Array.isArray(obj)) {
    return obj.slice();
  } else {
    return toArray(obj);
  }
}

module.exports = createArrayFrom;

},{"./toArray":143}],103:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule createFullPageComponent
 * @typechecks
 */

"use strict";

// Defeat circular references by requiring this directly.
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");

var invariant = require("./invariant");

/**
 * Create a component that will throw an exception when unmounted.
 *
 * Components like <html> <head> and <body> can't be removed or added
 * easily in a cross-browser way, however it's valuable to be able to
 * take advantage of React's reconciliation for styling and <title>
 * management. So we just document it and throw in dangerous cases.
 *
 * @param {string} tag The tag to wrap
 * @return {function} convenience constructor of new component
 */
function createFullPageComponent(tag) {
  var elementFactory = ReactElement.createFactory(tag);

  var FullPageComponent = ReactCompositeComponent.createClass({
    displayName: 'ReactFullPageComponent' + tag,

    componentWillUnmount: function() {
      ("production" !== process.env.NODE_ENV ? invariant(
        false,
        '%s tried to unmount. Because of cross-browser quirks it is ' +
        'impossible to unmount some top-level components (eg <html>, <head>, ' +
        'and <body>) reliably and efficiently. To fix this, have a single ' +
        'top-level component that never unmounts render these elements.',
        this.constructor.displayName
      ) : invariant(false));
    },

    render: function() {
      return elementFactory(this.props);
    }
  });

  return FullPageComponent;
}

module.exports = createFullPageComponent;

}).call(this,require('_process'))
},{"./ReactCompositeComponent":34,"./ReactElement":52,"./invariant":126,"_process":152}],104:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule createNodesFromMarkup
 * @typechecks
 */

/*jslint evil: true, sub: true */

var ExecutionEnvironment = require("./ExecutionEnvironment");

var createArrayFrom = require("./createArrayFrom");
var getMarkupWrap = require("./getMarkupWrap");
var invariant = require("./invariant");

/**
 * Dummy container used to render all markup.
 */
var dummyNode =
  ExecutionEnvironment.canUseDOM ? document.createElement('div') : null;

/**
 * Pattern used by `getNodeName`.
 */
var nodeNamePattern = /^\s*<(\w+)/;

/**
 * Extracts the `nodeName` of the first element in a string of markup.
 *
 * @param {string} markup String of markup.
 * @return {?string} Node name of the supplied markup.
 */
function getNodeName(markup) {
  var nodeNameMatch = markup.match(nodeNamePattern);
  return nodeNameMatch && nodeNameMatch[1].toLowerCase();
}

/**
 * Creates an array containing the nodes rendered from the supplied markup. The
 * optionally supplied `handleScript` function will be invoked once for each
 * <script> element that is rendered. If no `handleScript` function is supplied,
 * an exception is thrown if any <script> elements are rendered.
 *
 * @param {string} markup A string of valid HTML markup.
 * @param {?function} handleScript Invoked once for each rendered <script>.
 * @return {array<DOMElement|DOMTextNode>} An array of rendered nodes.
 */
function createNodesFromMarkup(markup, handleScript) {
  var node = dummyNode;
  ("production" !== process.env.NODE_ENV ? invariant(!!dummyNode, 'createNodesFromMarkup dummy not initialized') : invariant(!!dummyNode));
  var nodeName = getNodeName(markup);

  var wrap = nodeName && getMarkupWrap(nodeName);
  if (wrap) {
    node.innerHTML = wrap[1] + markup + wrap[2];

    var wrapDepth = wrap[0];
    while (wrapDepth--) {
      node = node.lastChild;
    }
  } else {
    node.innerHTML = markup;
  }

  var scripts = node.getElementsByTagName('script');
  if (scripts.length) {
    ("production" !== process.env.NODE_ENV ? invariant(
      handleScript,
      'createNodesFromMarkup(...): Unexpected <script> element rendered.'
    ) : invariant(handleScript));
    createArrayFrom(scripts).forEach(handleScript);
  }

  var nodes = createArrayFrom(node.childNodes);
  while (node.lastChild) {
    node.removeChild(node.lastChild);
  }
  return nodes;
}

module.exports = createNodesFromMarkup;

}).call(this,require('_process'))
},{"./ExecutionEnvironment":21,"./createArrayFrom":102,"./getMarkupWrap":118,"./invariant":126,"_process":152}],105:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule dangerousStyleValue
 * @typechecks static-only
 */

"use strict";

var CSSProperty = require("./CSSProperty");

var isUnitlessNumber = CSSProperty.isUnitlessNumber;

/**
 * Convert a value into the proper css writable value. The style name `name`
 * should be logical (no hyphens), as specified
 * in `CSSProperty.isUnitlessNumber`.
 *
 * @param {string} name CSS property name such as `topMargin`.
 * @param {*} value CSS property value such as `10px`.
 * @return {string} Normalized style value with dimensions applied.
 */
function dangerousStyleValue(name, value) {
  // Note that we've removed escapeTextForBrowser() calls here since the
  // whole string will be escaped when the attribute is injected into
  // the markup. If you provide unsafe user data here they can inject
  // arbitrary CSS which may be problematic (I couldn't repro this):
  // https://www.owasp.org/index.php/XSS_Filter_Evasion_Cheat_Sheet
  // http://www.thespanner.co.uk/2007/11/26/ultimate-xss-css-injection/
  // This is not an XSS hole but instead a potential CSS injection issue
  // which has lead to a greater discussion about how we're going to
  // trust URLs moving forward. See #2115901

  var isEmpty = value == null || typeof value === 'boolean' || value === '';
  if (isEmpty) {
    return '';
  }

  var isNonNumeric = isNaN(value);
  if (isNonNumeric || value === 0 ||
      isUnitlessNumber.hasOwnProperty(name) && isUnitlessNumber[name]) {
    return '' + value; // cast to string
  }

  if (typeof value === 'string') {
    value = value.trim();
  }
  return value + 'px';
}

module.exports = dangerousStyleValue;

},{"./CSSProperty":3}],106:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule deprecated
 */

var assign = require("./Object.assign");
var warning = require("./warning");

/**
 * This will log a single deprecation notice per function and forward the call
 * on to the new API.
 *
 * @param {string} namespace The namespace of the call, eg 'React'
 * @param {string} oldName The old function name, eg 'renderComponent'
 * @param {string} newName The new function name, eg 'render'
 * @param {*} ctx The context this forwarded call should run in
 * @param {function} fn The function to forward on to
 * @return {*} Will be the value as returned from `fn`
 */
function deprecated(namespace, oldName, newName, ctx, fn) {
  var warned = false;
  if ("production" !== process.env.NODE_ENV) {
    var newFn = function() {
      ("production" !== process.env.NODE_ENV ? warning(
        warned,
        (namespace + "." + oldName + " will be deprecated in a future version. ") +
        ("Use " + namespace + "." + newName + " instead.")
      ) : null);
      warned = true;
      return fn.apply(ctx, arguments);
    };
    newFn.displayName = (namespace + "_" + oldName);
    // We need to make sure all properties of the original fn are copied over.
    // In particular, this is needed to support PropTypes
    return assign(newFn, fn);
  }

  return fn;
}

module.exports = deprecated;

}).call(this,require('_process'))
},{"./Object.assign":26,"./warning":145,"_process":152}],107:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule emptyFunction
 */

function makeEmptyFunction(arg) {
  return function() {
    return arg;
  };
}

/**
 * This function accepts and discards inputs; it has no side effects. This is
 * primarily useful idiomatically for overridable function endpoints which
 * always need to be callable, since JS lacks a null-call idiom ala Cocoa.
 */
function emptyFunction() {}

emptyFunction.thatReturns = makeEmptyFunction;
emptyFunction.thatReturnsFalse = makeEmptyFunction(false);
emptyFunction.thatReturnsTrue = makeEmptyFunction(true);
emptyFunction.thatReturnsNull = makeEmptyFunction(null);
emptyFunction.thatReturnsThis = function() { return this; };
emptyFunction.thatReturnsArgument = function(arg) { return arg; };

module.exports = emptyFunction;

},{}],108:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule emptyObject
 */

"use strict";

var emptyObject = {};

if ("production" !== process.env.NODE_ENV) {
  Object.freeze(emptyObject);
}

module.exports = emptyObject;

}).call(this,require('_process'))
},{"_process":152}],109:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule escapeTextForBrowser
 * @typechecks static-only
 */

"use strict";

var ESCAPE_LOOKUP = {
  "&": "&amp;",
  ">": "&gt;",
  "<": "&lt;",
  "\"": "&quot;",
  "'": "&#x27;"
};

var ESCAPE_REGEX = /[&><"']/g;

function escaper(match) {
  return ESCAPE_LOOKUP[match];
}

/**
 * Escapes text to prevent scripting attacks.
 *
 * @param {*} text Text value to escape.
 * @return {string} An escaped string.
 */
function escapeTextForBrowser(text) {
  return ('' + text).replace(ESCAPE_REGEX, escaper);
}

module.exports = escapeTextForBrowser;

},{}],110:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule flattenChildren
 */

"use strict";

var ReactTextComponent = require("./ReactTextComponent");

var traverseAllChildren = require("./traverseAllChildren");
var warning = require("./warning");

/**
 * @param {function} traverseContext Context passed through traversal.
 * @param {?ReactComponent} child React child component.
 * @param {!string} name String name of key path to child.
 */
function flattenSingleChildIntoContext(traverseContext, child, name) {
  // We found a component instance.
  var result = traverseContext;
  var keyUnique = !result.hasOwnProperty(name);
  ("production" !== process.env.NODE_ENV ? warning(
    keyUnique,
    'flattenChildren(...): Encountered two children with the same key, ' +
    '`%s`. Child keys must be unique; when two children share a key, only ' +
    'the first child will be used.',
    name
  ) : null);
  if (keyUnique && child != null) {
    var type = typeof child;
    var normalizedValue;

    if (type === 'string') {
      normalizedValue = ReactTextComponent(child);
    } else if (type === 'number') {
      normalizedValue = ReactTextComponent('' + child);
    } else {
      normalizedValue = child;
    }

    result[name] = normalizedValue;
  }
}

/**
 * Flattens children that are typically specified as `props.children`. Any null
 * children will not be included in the resulting object.
 * @return {!object} flattened children keyed by name.
 */
function flattenChildren(children) {
  if (children == null) {
    return children;
  }
  var result = {};
  traverseAllChildren(children, flattenSingleChildIntoContext, result);
  return result;
}

module.exports = flattenChildren;

}).call(this,require('_process'))
},{"./ReactTextComponent":78,"./traverseAllChildren":144,"./warning":145,"_process":152}],111:[function(require,module,exports){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule focusNode
 */

"use strict";

/**
 * @param {DOMElement} node input/textarea to focus
 */
function focusNode(node) {
  // IE8 can throw "Can't move focus to the control because it is invisible,
  // not enabled, or of a type that does not accept the focus." for all kinds of
  // reasons that are too expensive and fragile to test.
  try {
    node.focus();
  } catch(e) {
  }
}

module.exports = focusNode;

},{}],112:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule forEachAccumulated
 */

"use strict";

/**
 * @param {array} an "accumulation" of items which is either an Array or
 * a single item. Useful when paired with the `accumulate` module. This is a
 * simple utility that allows us to reason about a collection of items, but
 * handling the case when there is exactly one item (and we do not need to
 * allocate an array).
 */
var forEachAccumulated = function(arr, cb, scope) {
  if (Array.isArray(arr)) {
    arr.forEach(cb, scope);
  } else if (arr) {
    cb.call(scope, arr);
  }
};

module.exports = forEachAccumulated;

},{}],113:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getActiveElement
 * @typechecks
 */

/**
 * Same as document.activeElement but wraps in a try-catch block. In IE it is
 * not safe to call document.activeElement if there is nothing focused.
 *
 * The activeElement will be null only if the document body is not yet defined.
 */
function getActiveElement() /*?DOMElement*/ {
  try {
    return document.activeElement || document.body;
  } catch (e) {
    return document.body;
  }
}

module.exports = getActiveElement;

},{}],114:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getEventCharCode
 * @typechecks static-only
 */

"use strict";

/**
 * `charCode` represents the actual "character code" and is safe to use with
 * `String.fromCharCode`. As such, only keys that correspond to printable
 * characters produce a valid `charCode`, the only exception to this is Enter.
 * The Tab-key is considered non-printable and does not have a `charCode`,
 * presumably because it does not produce a tab-character in browsers.
 *
 * @param {object} nativeEvent Native browser event.
 * @return {string} Normalized `charCode` property.
 */
function getEventCharCode(nativeEvent) {
  var charCode;
  var keyCode = nativeEvent.keyCode;

  if ('charCode' in nativeEvent) {
    charCode = nativeEvent.charCode;

    // FF does not set `charCode` for the Enter-key, check against `keyCode`.
    if (charCode === 0 && keyCode === 13) {
      charCode = 13;
    }
  } else {
    // IE8 does not implement `charCode`, but `keyCode` has the correct value.
    charCode = keyCode;
  }

  // Some non-printable keys are reported in `charCode`/`keyCode`, discard them.
  // Must not discard the (non-)printable Enter-key.
  if (charCode >= 32 || charCode === 13) {
    return charCode;
  }

  return 0;
}

module.exports = getEventCharCode;

},{}],115:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getEventKey
 * @typechecks static-only
 */

"use strict";

var getEventCharCode = require("./getEventCharCode");

/**
 * Normalization of deprecated HTML5 `key` values
 * @see https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent#Key_names
 */
var normalizeKey = {
  'Esc': 'Escape',
  'Spacebar': ' ',
  'Left': 'ArrowLeft',
  'Up': 'ArrowUp',
  'Right': 'ArrowRight',
  'Down': 'ArrowDown',
  'Del': 'Delete',
  'Win': 'OS',
  'Menu': 'ContextMenu',
  'Apps': 'ContextMenu',
  'Scroll': 'ScrollLock',
  'MozPrintableKey': 'Unidentified'
};

/**
 * Translation from legacy `keyCode` to HTML5 `key`
 * Only special keys supported, all others depend on keyboard layout or browser
 * @see https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent#Key_names
 */
var translateToKey = {
  8: 'Backspace',
  9: 'Tab',
  12: 'Clear',
  13: 'Enter',
  16: 'Shift',
  17: 'Control',
  18: 'Alt',
  19: 'Pause',
  20: 'CapsLock',
  27: 'Escape',
  32: ' ',
  33: 'PageUp',
  34: 'PageDown',
  35: 'End',
  36: 'Home',
  37: 'ArrowLeft',
  38: 'ArrowUp',
  39: 'ArrowRight',
  40: 'ArrowDown',
  45: 'Insert',
  46: 'Delete',
  112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6',
  118: 'F7', 119: 'F8', 120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12',
  144: 'NumLock',
  145: 'ScrollLock',
  224: 'Meta'
};

/**
 * @param {object} nativeEvent Native browser event.
 * @return {string} Normalized `key` property.
 */
function getEventKey(nativeEvent) {
  if (nativeEvent.key) {
    // Normalize inconsistent values reported by browsers due to
    // implementations of a working draft specification.

    // FireFox implements `key` but returns `MozPrintableKey` for all
    // printable characters (normalized to `Unidentified`), ignore it.
    var key = normalizeKey[nativeEvent.key] || nativeEvent.key;
    if (key !== 'Unidentified') {
      return key;
    }
  }

  // Browser does not implement `key`, polyfill as much of it as we can.
  if (nativeEvent.type === 'keypress') {
    var charCode = getEventCharCode(nativeEvent);

    // The enter-key is technically both printable and non-printable and can
    // thus be captured by `keypress`, no other non-printable key should.
    return charCode === 13 ? 'Enter' : String.fromCharCode(charCode);
  }
  if (nativeEvent.type === 'keydown' || nativeEvent.type === 'keyup') {
    // While user keyboard layout determines the actual meaning of each
    // `keyCode` value, almost all function keys have a universal value.
    return translateToKey[nativeEvent.keyCode] || 'Unidentified';
  }
  return '';
}

module.exports = getEventKey;

},{"./getEventCharCode":114}],116:[function(require,module,exports){
/**
 * Copyright 2013 Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getEventModifierState
 * @typechecks static-only
 */

"use strict";

/**
 * Translation from modifier key to the associated property in the event.
 * @see http://www.w3.org/TR/DOM-Level-3-Events/#keys-Modifiers
 */

var modifierKeyToProp = {
  'Alt': 'altKey',
  'Control': 'ctrlKey',
  'Meta': 'metaKey',
  'Shift': 'shiftKey'
};

// IE8 does not implement getModifierState so we simply map it to the only
// modifier keys exposed by the event itself, does not support Lock-keys.
// Currently, all major browsers except Chrome seems to support Lock-keys.
function modifierStateGetter(keyArg) {
  /*jshint validthis:true */
  var syntheticEvent = this;
  var nativeEvent = syntheticEvent.nativeEvent;
  if (nativeEvent.getModifierState) {
    return nativeEvent.getModifierState(keyArg);
  }
  var keyProp = modifierKeyToProp[keyArg];
  return keyProp ? !!nativeEvent[keyProp] : false;
}

function getEventModifierState(nativeEvent) {
  return modifierStateGetter;
}

module.exports = getEventModifierState;

},{}],117:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getEventTarget
 * @typechecks static-only
 */

"use strict";

/**
 * Gets the target node from a native browser event by accounting for
 * inconsistencies in browser DOM APIs.
 *
 * @param {object} nativeEvent Native browser event.
 * @return {DOMEventTarget} Target node.
 */
function getEventTarget(nativeEvent) {
  var target = nativeEvent.target || nativeEvent.srcElement || window;
  // Safari may fire events on text nodes (Node.TEXT_NODE is 3).
  // @see http://www.quirksmode.org/js/events_properties.html
  return target.nodeType === 3 ? target.parentNode : target;
}

module.exports = getEventTarget;

},{}],118:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getMarkupWrap
 */

var ExecutionEnvironment = require("./ExecutionEnvironment");

var invariant = require("./invariant");

/**
 * Dummy container used to detect which wraps are necessary.
 */
var dummyNode =
  ExecutionEnvironment.canUseDOM ? document.createElement('div') : null;

/**
 * Some browsers cannot use `innerHTML` to render certain elements standalone,
 * so we wrap them, render the wrapped nodes, then extract the desired node.
 *
 * In IE8, certain elements cannot render alone, so wrap all elements ('*').
 */
var shouldWrap = {
  // Force wrapping for SVG elements because if they get created inside a <div>,
  // they will be initialized in the wrong namespace (and will not display).
  'circle': true,
  'defs': true,
  'ellipse': true,
  'g': true,
  'line': true,
  'linearGradient': true,
  'path': true,
  'polygon': true,
  'polyline': true,
  'radialGradient': true,
  'rect': true,
  'stop': true,
  'text': true
};

var selectWrap = [1, '<select multiple="true">', '</select>'];
var tableWrap = [1, '<table>', '</table>'];
var trWrap = [3, '<table><tbody><tr>', '</tr></tbody></table>'];

var svgWrap = [1, '<svg>', '</svg>'];

var markupWrap = {
  '*': [1, '?<div>', '</div>'],

  'area': [1, '<map>', '</map>'],
  'col': [2, '<table><tbody></tbody><colgroup>', '</colgroup></table>'],
  'legend': [1, '<fieldset>', '</fieldset>'],
  'param': [1, '<object>', '</object>'],
  'tr': [2, '<table><tbody>', '</tbody></table>'],

  'optgroup': selectWrap,
  'option': selectWrap,

  'caption': tableWrap,
  'colgroup': tableWrap,
  'tbody': tableWrap,
  'tfoot': tableWrap,
  'thead': tableWrap,

  'td': trWrap,
  'th': trWrap,

  'circle': svgWrap,
  'defs': svgWrap,
  'ellipse': svgWrap,
  'g': svgWrap,
  'line': svgWrap,
  'linearGradient': svgWrap,
  'path': svgWrap,
  'polygon': svgWrap,
  'polyline': svgWrap,
  'radialGradient': svgWrap,
  'rect': svgWrap,
  'stop': svgWrap,
  'text': svgWrap
};

/**
 * Gets the markup wrap configuration for the supplied `nodeName`.
 *
 * NOTE: This lazily detects which wraps are necessary for the current browser.
 *
 * @param {string} nodeName Lowercase `nodeName`.
 * @return {?array} Markup wrap configuration, if applicable.
 */
function getMarkupWrap(nodeName) {
  ("production" !== process.env.NODE_ENV ? invariant(!!dummyNode, 'Markup wrapping node not initialized') : invariant(!!dummyNode));
  if (!markupWrap.hasOwnProperty(nodeName)) {
    nodeName = '*';
  }
  if (!shouldWrap.hasOwnProperty(nodeName)) {
    if (nodeName === '*') {
      dummyNode.innerHTML = '<link />';
    } else {
      dummyNode.innerHTML = '<' + nodeName + '></' + nodeName + '>';
    }
    shouldWrap[nodeName] = !dummyNode.firstChild;
  }
  return shouldWrap[nodeName] ? markupWrap[nodeName] : null;
}


module.exports = getMarkupWrap;

}).call(this,require('_process'))
},{"./ExecutionEnvironment":21,"./invariant":126,"_process":152}],119:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getNodeForCharacterOffset
 */

"use strict";

/**
 * Given any node return the first leaf node without children.
 *
 * @param {DOMElement|DOMTextNode} node
 * @return {DOMElement|DOMTextNode}
 */
function getLeafNode(node) {
  while (node && node.firstChild) {
    node = node.firstChild;
  }
  return node;
}

/**
 * Get the next sibling within a container. This will walk up the
 * DOM if a node's siblings have been exhausted.
 *
 * @param {DOMElement|DOMTextNode} node
 * @return {?DOMElement|DOMTextNode}
 */
function getSiblingNode(node) {
  while (node) {
    if (node.nextSibling) {
      return node.nextSibling;
    }
    node = node.parentNode;
  }
}

/**
 * Get object describing the nodes which contain characters at offset.
 *
 * @param {DOMElement|DOMTextNode} root
 * @param {number} offset
 * @return {?object}
 */
function getNodeForCharacterOffset(root, offset) {
  var node = getLeafNode(root);
  var nodeStart = 0;
  var nodeEnd = 0;

  while (node) {
    if (node.nodeType == 3) {
      nodeEnd = nodeStart + node.textContent.length;

      if (nodeStart <= offset && nodeEnd >= offset) {
        return {
          node: node,
          offset: offset - nodeStart
        };
      }

      nodeStart = nodeEnd;
    }

    node = getLeafNode(getSiblingNode(node));
  }
}

module.exports = getNodeForCharacterOffset;

},{}],120:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getReactRootElementInContainer
 */

"use strict";

var DOC_NODE_TYPE = 9;

/**
 * @param {DOMElement|DOMDocument} container DOM element that may contain
 *                                           a React component
 * @return {?*} DOM element that may have the reactRoot ID, or null.
 */
function getReactRootElementInContainer(container) {
  if (!container) {
    return null;
  }

  if (container.nodeType === DOC_NODE_TYPE) {
    return container.documentElement;
  } else {
    return container.firstChild;
  }
}

module.exports = getReactRootElementInContainer;

},{}],121:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getTextContentAccessor
 */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var contentKey = null;

/**
 * Gets the key used to access text content on a DOM node.
 *
 * @return {?string} Key used to access text content.
 * @internal
 */
function getTextContentAccessor() {
  if (!contentKey && ExecutionEnvironment.canUseDOM) {
    // Prefer textContent to innerText because many browsers support both but
    // SVG <text> elements don't support innerText even when <div> does.
    contentKey = 'textContent' in document.documentElement ?
      'textContent' :
      'innerText';
  }
  return contentKey;
}

module.exports = getTextContentAccessor;

},{"./ExecutionEnvironment":21}],122:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getUnboundedScrollPosition
 * @typechecks
 */

"use strict";

/**
 * Gets the scroll position of the supplied element or window.
 *
 * The return values are unbounded, unlike `getScrollPosition`. This means they
 * may be negative or exceed the element boundaries (which is possible using
 * inertial scrolling).
 *
 * @param {DOMWindow|DOMElement} scrollable
 * @return {object} Map with `x` and `y` keys.
 */
function getUnboundedScrollPosition(scrollable) {
  if (scrollable === window) {
    return {
      x: window.pageXOffset || document.documentElement.scrollLeft,
      y: window.pageYOffset || document.documentElement.scrollTop
    };
  }
  return {
    x: scrollable.scrollLeft,
    y: scrollable.scrollTop
  };
}

module.exports = getUnboundedScrollPosition;

},{}],123:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule hyphenate
 * @typechecks
 */

var _uppercasePattern = /([A-Z])/g;

/**
 * Hyphenates a camelcased string, for example:
 *
 *   > hyphenate('backgroundColor')
 *   < "background-color"
 *
 * For CSS style names, use `hyphenateStyleName` instead which works properly
 * with all vendor prefixes, including `ms`.
 *
 * @param {string} string
 * @return {string}
 */
function hyphenate(string) {
  return string.replace(_uppercasePattern, '-$1').toLowerCase();
}

module.exports = hyphenate;

},{}],124:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule hyphenateStyleName
 * @typechecks
 */

"use strict";

var hyphenate = require("./hyphenate");

var msPattern = /^ms-/;

/**
 * Hyphenates a camelcased CSS property name, for example:
 *
 *   > hyphenateStyleName('backgroundColor')
 *   < "background-color"
 *   > hyphenateStyleName('MozTransition')
 *   < "-moz-transition"
 *   > hyphenateStyleName('msTransition')
 *   < "-ms-transition"
 *
 * As Modernizr suggests (http://modernizr.com/docs/#prefixed), an `ms` prefix
 * is converted to `-ms-`.
 *
 * @param {string} string
 * @return {string}
 */
function hyphenateStyleName(string) {
  return hyphenate(string).replace(msPattern, '-ms-');
}

module.exports = hyphenateStyleName;

},{"./hyphenate":123}],125:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule instantiateReactComponent
 * @typechecks static-only
 */

"use strict";

var warning = require("./warning");

var ReactElement = require("./ReactElement");
var ReactLegacyElement = require("./ReactLegacyElement");
var ReactNativeComponent = require("./ReactNativeComponent");
var ReactEmptyComponent = require("./ReactEmptyComponent");

/**
 * Given an `element` create an instance that will actually be mounted.
 *
 * @param {object} element
 * @param {*} parentCompositeType The composite type that resolved this.
 * @return {object} A new instance of the element's constructor.
 * @protected
 */
function instantiateReactComponent(element, parentCompositeType) {
  var instance;

  if ("production" !== process.env.NODE_ENV) {
    ("production" !== process.env.NODE_ENV ? warning(
      element && (typeof element.type === 'function' ||
                     typeof element.type === 'string'),
      'Only functions or strings can be mounted as React components.'
    ) : null);

    // Resolve mock instances
    if (element.type._mockedReactClassConstructor) {
      // If this is a mocked class, we treat the legacy factory as if it was the
      // class constructor for future proofing unit tests. Because this might
      // be mocked as a legacy factory, we ignore any warnings triggerd by
      // this temporary hack.
      ReactLegacyElement._isLegacyCallWarningEnabled = false;
      try {
        instance = new element.type._mockedReactClassConstructor(
          element.props
        );
      } finally {
        ReactLegacyElement._isLegacyCallWarningEnabled = true;
      }

      // If the mock implementation was a legacy factory, then it returns a
      // element. We need to turn this into a real component instance.
      if (ReactElement.isValidElement(instance)) {
        instance = new instance.type(instance.props);
      }

      var render = instance.render;
      if (!render) {
        // For auto-mocked factories, the prototype isn't shimmed and therefore
        // there is no render function on the instance. We replace the whole
        // component with an empty component instance instead.
        element = ReactEmptyComponent.getEmptyComponent();
      } else {
        if (render._isMockFunction && !render._getMockImplementation()) {
          // Auto-mocked components may have a prototype with a mocked render
          // function. For those, we'll need to mock the result of the render
          // since we consider undefined to be invalid results from render.
          render.mockImplementation(
            ReactEmptyComponent.getEmptyComponent
          );
        }
        instance.construct(element);
        return instance;
      }
    }
  }

  // Special case string values
  if (typeof element.type === 'string') {
    instance = ReactNativeComponent.createInstanceForTag(
      element.type,
      element.props,
      parentCompositeType
    );
  } else {
    // Normal case for non-mocks and non-strings
    instance = new element.type(element.props);
  }

  if ("production" !== process.env.NODE_ENV) {
    ("production" !== process.env.NODE_ENV ? warning(
      typeof instance.construct === 'function' &&
      typeof instance.mountComponent === 'function' &&
      typeof instance.receiveComponent === 'function',
      'Only React Components can be mounted.'
    ) : null);
  }

  // This actually sets up the internal instance. This will become decoupled
  // from the public instance in a future diff.
  instance.construct(element);

  return instance;
}

module.exports = instantiateReactComponent;

}).call(this,require('_process'))
},{"./ReactElement":52,"./ReactEmptyComponent":54,"./ReactLegacyElement":61,"./ReactNativeComponent":66,"./warning":145,"_process":152}],126:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule invariant
 */

"use strict";

/**
 * Use invariant() to assert state which your program assumes to be true.
 *
 * Provide sprintf-style format (only %s is supported) and arguments
 * to provide information about what broke and what you were
 * expecting.
 *
 * The invariant message will be stripped in production, but the invariant
 * will remain to ensure logic does not differ in production.
 */

var invariant = function(condition, format, a, b, c, d, e, f) {
  if ("production" !== process.env.NODE_ENV) {
    if (format === undefined) {
      throw new Error('invariant requires an error message argument');
    }
  }

  if (!condition) {
    var error;
    if (format === undefined) {
      error = new Error(
        'Minified exception occurred; use the non-minified dev environment ' +
        'for the full error message and additional helpful warnings.'
      );
    } else {
      var args = [a, b, c, d, e, f];
      var argIndex = 0;
      error = new Error(
        'Invariant Violation: ' +
        format.replace(/%s/g, function() { return args[argIndex++]; })
      );
    }

    error.framesToPop = 1; // we don't care about invariant's own frame
    throw error;
  }
};

module.exports = invariant;

}).call(this,require('_process'))
},{"_process":152}],127:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule isEventSupported
 */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var useHasFeature;
if (ExecutionEnvironment.canUseDOM) {
  useHasFeature =
    document.implementation &&
    document.implementation.hasFeature &&
    // always returns true in newer browsers as per the standard.
    // @see http://dom.spec.whatwg.org/#dom-domimplementation-hasfeature
    document.implementation.hasFeature('', '') !== true;
}

/**
 * Checks if an event is supported in the current execution environment.
 *
 * NOTE: This will not work correctly for non-generic events such as `change`,
 * `reset`, `load`, `error`, and `select`.
 *
 * Borrows from Modernizr.
 *
 * @param {string} eventNameSuffix Event name, e.g. "click".
 * @param {?boolean} capture Check if the capture phase is supported.
 * @return {boolean} True if the event is supported.
 * @internal
 * @license Modernizr 3.0.0pre (Custom Build) | MIT
 */
function isEventSupported(eventNameSuffix, capture) {
  if (!ExecutionEnvironment.canUseDOM ||
      capture && !('addEventListener' in document)) {
    return false;
  }

  var eventName = 'on' + eventNameSuffix;
  var isSupported = eventName in document;

  if (!isSupported) {
    var element = document.createElement('div');
    element.setAttribute(eventName, 'return;');
    isSupported = typeof element[eventName] === 'function';
  }

  if (!isSupported && useHasFeature && eventNameSuffix === 'wheel') {
    // This is the only way to test support for the `wheel` event in IE9+.
    isSupported = document.implementation.hasFeature('Events.wheel', '3.0');
  }

  return isSupported;
}

module.exports = isEventSupported;

},{"./ExecutionEnvironment":21}],128:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule isNode
 * @typechecks
 */

/**
 * @param {*} object The object to check.
 * @return {boolean} Whether or not the object is a DOM node.
 */
function isNode(object) {
  return !!(object && (
    typeof Node === 'function' ? object instanceof Node :
      typeof object === 'object' &&
      typeof object.nodeType === 'number' &&
      typeof object.nodeName === 'string'
  ));
}

module.exports = isNode;

},{}],129:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule isTextInputElement
 */

"use strict";

/**
 * @see http://www.whatwg.org/specs/web-apps/current-work/multipage/the-input-element.html#input-type-attr-summary
 */
var supportedInputTypes = {
  'color': true,
  'date': true,
  'datetime': true,
  'datetime-local': true,
  'email': true,
  'month': true,
  'number': true,
  'password': true,
  'range': true,
  'search': true,
  'tel': true,
  'text': true,
  'time': true,
  'url': true,
  'week': true
};

function isTextInputElement(elem) {
  return elem && (
    (elem.nodeName === 'INPUT' && supportedInputTypes[elem.type]) ||
    elem.nodeName === 'TEXTAREA'
  );
}

module.exports = isTextInputElement;

},{}],130:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule isTextNode
 * @typechecks
 */

var isNode = require("./isNode");

/**
 * @param {*} object The object to check.
 * @return {boolean} Whether or not the object is a DOM text node.
 */
function isTextNode(object) {
  return isNode(object) && object.nodeType == 3;
}

module.exports = isTextNode;

},{"./isNode":128}],131:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule joinClasses
 * @typechecks static-only
 */

"use strict";

/**
 * Combines multiple className strings into one.
 * http://jsperf.com/joinclasses-args-vs-array
 *
 * @param {...?string} classes
 * @return {string}
 */
function joinClasses(className/*, ... */) {
  if (!className) {
    className = '';
  }
  var nextClass;
  var argLength = arguments.length;
  if (argLength > 1) {
    for (var ii = 1; ii < argLength; ii++) {
      nextClass = arguments[ii];
      if (nextClass) {
        className = (className ? className + ' ' : '') + nextClass;
      }
    }
  }
  return className;
}

module.exports = joinClasses;

},{}],132:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule keyMirror
 * @typechecks static-only
 */

"use strict";

var invariant = require("./invariant");

/**
 * Constructs an enumeration with keys equal to their value.
 *
 * For example:
 *
 *   var COLORS = keyMirror({blue: null, red: null});
 *   var myColor = COLORS.blue;
 *   var isColorValid = !!COLORS[myColor];
 *
 * The last line could not be performed if the values of the generated enum were
 * not equal to their keys.
 *
 *   Input:  {key1: val1, key2: val2}
 *   Output: {key1: key1, key2: key2}
 *
 * @param {object} obj
 * @return {object}
 */
var keyMirror = function(obj) {
  var ret = {};
  var key;
  ("production" !== process.env.NODE_ENV ? invariant(
    obj instanceof Object && !Array.isArray(obj),
    'keyMirror(...): Argument must be an object.'
  ) : invariant(obj instanceof Object && !Array.isArray(obj)));
  for (key in obj) {
    if (!obj.hasOwnProperty(key)) {
      continue;
    }
    ret[key] = key;
  }
  return ret;
};

module.exports = keyMirror;

}).call(this,require('_process'))
},{"./invariant":126,"_process":152}],133:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule keyOf
 */

/**
 * Allows extraction of a minified key. Let's the build system minify keys
 * without loosing the ability to dynamically use key strings as values
 * themselves. Pass in an object with a single key/val pair and it will return
 * you the string key of that single record. Suppose you want to grab the
 * value for a key 'className' inside of an object. Key/val minification may
 * have aliased that key to be 'xa12'. keyOf({className: null}) will return
 * 'xa12' in that case. Resolve keys you want to use once at startup time, then
 * reuse those resolutions.
 */
var keyOf = function(oneKeyObj) {
  var key;
  for (key in oneKeyObj) {
    if (!oneKeyObj.hasOwnProperty(key)) {
      continue;
    }
    return key;
  }
  return null;
};


module.exports = keyOf;

},{}],134:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule mapObject
 */

'use strict';

var hasOwnProperty = Object.prototype.hasOwnProperty;

/**
 * Executes the provided `callback` once for each enumerable own property in the
 * object and constructs a new object from the results. The `callback` is
 * invoked with three arguments:
 *
 *  - the property value
 *  - the property name
 *  - the object being traversed
 *
 * Properties that are added after the call to `mapObject` will not be visited
 * by `callback`. If the values of existing properties are changed, the value
 * passed to `callback` will be the value at the time `mapObject` visits them.
 * Properties that are deleted before being visited are not visited.
 *
 * @grep function objectMap()
 * @grep function objMap()
 *
 * @param {?object} object
 * @param {function} callback
 * @param {*} context
 * @return {?object}
 */
function mapObject(object, callback, context) {
  if (!object) {
    return null;
  }
  var result = {};
  for (var name in object) {
    if (hasOwnProperty.call(object, name)) {
      result[name] = callback.call(context, object[name], name, object);
    }
  }
  return result;
}

module.exports = mapObject;

},{}],135:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule memoizeStringOnly
 * @typechecks static-only
 */

"use strict";

/**
 * Memoizes the return value of a function that accepts one string argument.
 *
 * @param {function} callback
 * @return {function}
 */
function memoizeStringOnly(callback) {
  var cache = {};
  return function(string) {
    if (cache.hasOwnProperty(string)) {
      return cache[string];
    } else {
      return cache[string] = callback.call(this, string);
    }
  };
}

module.exports = memoizeStringOnly;

},{}],136:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule monitorCodeUse
 */

"use strict";

var invariant = require("./invariant");

/**
 * Provides open-source compatible instrumentation for monitoring certain API
 * uses before we're ready to issue a warning or refactor. It accepts an event
 * name which may only contain the characters [a-z0-9_] and an optional data
 * object with further information.
 */

function monitorCodeUse(eventName, data) {
  ("production" !== process.env.NODE_ENV ? invariant(
    eventName && !/[^a-z0-9_]/.test(eventName),
    'You must provide an eventName using only the characters [a-z0-9_]'
  ) : invariant(eventName && !/[^a-z0-9_]/.test(eventName)));
}

module.exports = monitorCodeUse;

}).call(this,require('_process'))
},{"./invariant":126,"_process":152}],137:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule onlyChild
 */
"use strict";

var ReactElement = require("./ReactElement");

var invariant = require("./invariant");

/**
 * Returns the first child in a collection of children and verifies that there
 * is only one child in the collection. The current implementation of this
 * function assumes that a single child gets passed without a wrapper, but the
 * purpose of this helper function is to abstract away the particular structure
 * of children.
 *
 * @param {?object} children Child collection structure.
 * @return {ReactComponent} The first and only `ReactComponent` contained in the
 * structure.
 */
function onlyChild(children) {
  ("production" !== process.env.NODE_ENV ? invariant(
    ReactElement.isValidElement(children),
    'onlyChild must be passed a children with exactly one child.'
  ) : invariant(ReactElement.isValidElement(children)));
  return children;
}

module.exports = onlyChild;

}).call(this,require('_process'))
},{"./ReactElement":52,"./invariant":126,"_process":152}],138:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule performance
 * @typechecks
 */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var performance;

if (ExecutionEnvironment.canUseDOM) {
  performance =
    window.performance ||
    window.msPerformance ||
    window.webkitPerformance;
}

module.exports = performance || {};

},{"./ExecutionEnvironment":21}],139:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule performanceNow
 * @typechecks
 */

var performance = require("./performance");

/**
 * Detect if we can use `window.performance.now()` and gracefully fallback to
 * `Date.now()` if it doesn't exist. We need to support Firefox < 15 for now
 * because of Facebook's testing infrastructure.
 */
if (!performance || !performance.now) {
  performance = Date;
}

var performanceNow = performance.now.bind(performance);

module.exports = performanceNow;

},{"./performance":138}],140:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule setInnerHTML
 */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var WHITESPACE_TEST = /^[ \r\n\t\f]/;
var NONVISIBLE_TEST = /<(!--|link|noscript|meta|script|style)[ \r\n\t\f\/>]/;

/**
 * Set the innerHTML property of a node, ensuring that whitespace is preserved
 * even in IE8.
 *
 * @param {DOMElement} node
 * @param {string} html
 * @internal
 */
var setInnerHTML = function(node, html) {
  node.innerHTML = html;
};

if (ExecutionEnvironment.canUseDOM) {
  // IE8: When updating a just created node with innerHTML only leading
  // whitespace is removed. When updating an existing node with innerHTML
  // whitespace in root TextNodes is also collapsed.
  // @see quirksmode.org/bugreports/archives/2004/11/innerhtml_and_t.html

  // Feature detection; only IE8 is known to behave improperly like this.
  var testElement = document.createElement('div');
  testElement.innerHTML = ' ';
  if (testElement.innerHTML === '') {
    setInnerHTML = function(node, html) {
      // Magic theory: IE8 supposedly differentiates between added and updated
      // nodes when processing innerHTML, innerHTML on updated nodes suffers
      // from worse whitespace behavior. Re-adding a node like this triggers
      // the initial and more favorable whitespace behavior.
      // TODO: What to do on a detached node?
      if (node.parentNode) {
        node.parentNode.replaceChild(node, node);
      }

      // We also implement a workaround for non-visible tags disappearing into
      // thin air on IE8, this only happens if there is no visible text
      // in-front of the non-visible tags. Piggyback on the whitespace fix
      // and simply check if any non-visible tags appear in the source.
      if (WHITESPACE_TEST.test(html) ||
          html[0] === '<' && NONVISIBLE_TEST.test(html)) {
        // Recover leading whitespace by temporarily prepending any character.
        // \uFEFF has the potential advantage of being zero-width/invisible.
        node.innerHTML = '\uFEFF' + html;

        // deleteData leaves an empty `TextNode` which offsets the index of all
        // children. Definitely want to avoid this.
        var textNode = node.firstChild;
        if (textNode.data.length === 1) {
          node.removeChild(textNode);
        } else {
          textNode.deleteData(0, 1);
        }
      } else {
        node.innerHTML = html;
      }
    };
  }
}

module.exports = setInnerHTML;

},{"./ExecutionEnvironment":21}],141:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule shallowEqual
 */

"use strict";

/**
 * Performs equality by iterating through keys on an object and returning
 * false when any key has values which are not strictly equal between
 * objA and objB. Returns true when the values of all keys are strictly equal.
 *
 * @return {boolean}
 */
function shallowEqual(objA, objB) {
  if (objA === objB) {
    return true;
  }
  var key;
  // Test for A's keys different from B.
  for (key in objA) {
    if (objA.hasOwnProperty(key) &&
        (!objB.hasOwnProperty(key) || objA[key] !== objB[key])) {
      return false;
    }
  }
  // Test for B's keys missing from A.
  for (key in objB) {
    if (objB.hasOwnProperty(key) && !objA.hasOwnProperty(key)) {
      return false;
    }
  }
  return true;
}

module.exports = shallowEqual;

},{}],142:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule shouldUpdateReactComponent
 * @typechecks static-only
 */

"use strict";

/**
 * Given a `prevElement` and `nextElement`, determines if the existing
 * instance should be updated as opposed to being destroyed or replaced by a new
 * instance. Both arguments are elements. This ensures that this logic can
 * operate on stateless trees without any backing instance.
 *
 * @param {?object} prevElement
 * @param {?object} nextElement
 * @return {boolean} True if the existing instance should be updated.
 * @protected
 */
function shouldUpdateReactComponent(prevElement, nextElement) {
  if (prevElement && nextElement &&
      prevElement.type === nextElement.type &&
      prevElement.key === nextElement.key &&
      prevElement._owner === nextElement._owner) {
    return true;
  }
  return false;
}

module.exports = shouldUpdateReactComponent;

},{}],143:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule toArray
 * @typechecks
 */

var invariant = require("./invariant");

/**
 * Convert array-like objects to arrays.
 *
 * This API assumes the caller knows the contents of the data type. For less
 * well defined inputs use createArrayFrom.
 *
 * @param {object|function|filelist} obj
 * @return {array}
 */
function toArray(obj) {
  var length = obj.length;

  // Some browse builtin objects can report typeof 'function' (e.g. NodeList in
  // old versions of Safari).
  ("production" !== process.env.NODE_ENV ? invariant(
    !Array.isArray(obj) &&
    (typeof obj === 'object' || typeof obj === 'function'),
    'toArray: Array-like object expected'
  ) : invariant(!Array.isArray(obj) &&
  (typeof obj === 'object' || typeof obj === 'function')));

  ("production" !== process.env.NODE_ENV ? invariant(
    typeof length === 'number',
    'toArray: Object needs a length property'
  ) : invariant(typeof length === 'number'));

  ("production" !== process.env.NODE_ENV ? invariant(
    length === 0 ||
    (length - 1) in obj,
    'toArray: Object should have keys for indices'
  ) : invariant(length === 0 ||
  (length - 1) in obj));

  // Old IE doesn't give collections access to hasOwnProperty. Assume inputs
  // without method will throw during the slice call and skip straight to the
  // fallback.
  if (obj.hasOwnProperty) {
    try {
      return Array.prototype.slice.call(obj);
    } catch (e) {
      // IE < 9 does not support Array#slice on collections objects
    }
  }

  // Fall back to copying key by key. This assumes all keys have a value,
  // so will not preserve sparsely populated inputs.
  var ret = Array(length);
  for (var ii = 0; ii < length; ii++) {
    ret[ii] = obj[ii];
  }
  return ret;
}

module.exports = toArray;

}).call(this,require('_process'))
},{"./invariant":126,"_process":152}],144:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule traverseAllChildren
 */

"use strict";

var ReactElement = require("./ReactElement");
var ReactInstanceHandles = require("./ReactInstanceHandles");

var invariant = require("./invariant");

var SEPARATOR = ReactInstanceHandles.SEPARATOR;
var SUBSEPARATOR = ':';

/**
 * TODO: Test that:
 * 1. `mapChildren` transforms strings and numbers into `ReactTextComponent`.
 * 2. it('should fail when supplied duplicate key', function() {
 * 3. That a single child and an array with one item have the same key pattern.
 * });
 */

var userProvidedKeyEscaperLookup = {
  '=': '=0',
  '.': '=1',
  ':': '=2'
};

var userProvidedKeyEscapeRegex = /[=.:]/g;

function userProvidedKeyEscaper(match) {
  return userProvidedKeyEscaperLookup[match];
}

/**
 * Generate a key string that identifies a component within a set.
 *
 * @param {*} component A component that could contain a manual key.
 * @param {number} index Index that is used if a manual key is not provided.
 * @return {string}
 */
function getComponentKey(component, index) {
  if (component && component.key != null) {
    // Explicit key
    return wrapUserProvidedKey(component.key);
  }
  // Implicit key determined by the index in the set
  return index.toString(36);
}

/**
 * Escape a component key so that it is safe to use in a reactid.
 *
 * @param {*} key Component key to be escaped.
 * @return {string} An escaped string.
 */
function escapeUserProvidedKey(text) {
  return ('' + text).replace(
    userProvidedKeyEscapeRegex,
    userProvidedKeyEscaper
  );
}

/**
 * Wrap a `key` value explicitly provided by the user to distinguish it from
 * implicitly-generated keys generated by a component's index in its parent.
 *
 * @param {string} key Value of a user-provided `key` attribute
 * @return {string}
 */
function wrapUserProvidedKey(key) {
  return '$' + escapeUserProvidedKey(key);
}

/**
 * @param {?*} children Children tree container.
 * @param {!string} nameSoFar Name of the key path so far.
 * @param {!number} indexSoFar Number of children encountered until this point.
 * @param {!function} callback Callback to invoke with each child found.
 * @param {?*} traverseContext Used to pass information throughout the traversal
 * process.
 * @return {!number} The number of children in this subtree.
 */
var traverseAllChildrenImpl =
  function(children, nameSoFar, indexSoFar, callback, traverseContext) {
    var nextName, nextIndex;
    var subtreeCount = 0;  // Count of children found in the current subtree.
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        nextName = (
          nameSoFar +
          (nameSoFar ? SUBSEPARATOR : SEPARATOR) +
          getComponentKey(child, i)
        );
        nextIndex = indexSoFar + subtreeCount;
        subtreeCount += traverseAllChildrenImpl(
          child,
          nextName,
          nextIndex,
          callback,
          traverseContext
        );
      }
    } else {
      var type = typeof children;
      var isOnlyChild = nameSoFar === '';
      // If it's the only child, treat the name as if it was wrapped in an array
      // so that it's consistent if the number of children grows
      var storageName =
        isOnlyChild ? SEPARATOR + getComponentKey(children, 0) : nameSoFar;
      if (children == null || type === 'boolean') {
        // All of the above are perceived as null.
        callback(traverseContext, null, storageName, indexSoFar);
        subtreeCount = 1;
      } else if (type === 'string' || type === 'number' ||
                 ReactElement.isValidElement(children)) {
        callback(traverseContext, children, storageName, indexSoFar);
        subtreeCount = 1;
      } else if (type === 'object') {
        ("production" !== process.env.NODE_ENV ? invariant(
          !children || children.nodeType !== 1,
          'traverseAllChildren(...): Encountered an invalid child; DOM ' +
          'elements are not valid children of React components.'
        ) : invariant(!children || children.nodeType !== 1));
        for (var key in children) {
          if (children.hasOwnProperty(key)) {
            nextName = (
              nameSoFar + (nameSoFar ? SUBSEPARATOR : SEPARATOR) +
              wrapUserProvidedKey(key) + SUBSEPARATOR +
              getComponentKey(children[key], 0)
            );
            nextIndex = indexSoFar + subtreeCount;
            subtreeCount += traverseAllChildrenImpl(
              children[key],
              nextName,
              nextIndex,
              callback,
              traverseContext
            );
          }
        }
      }
    }
    return subtreeCount;
  };

/**
 * Traverses children that are typically specified as `props.children`, but
 * might also be specified through attributes:
 *
 * - `traverseAllChildren(this.props.children, ...)`
 * - `traverseAllChildren(this.props.leftPanelChildren, ...)`
 *
 * The `traverseContext` is an optional argument that is passed through the
 * entire traversal. It can be used to store accumulations or anything else that
 * the callback might find relevant.
 *
 * @param {?*} children Children tree object.
 * @param {!function} callback To invoke upon traversing each child.
 * @param {?*} traverseContext Context for traversal.
 * @return {!number} The number of children in this subtree.
 */
function traverseAllChildren(children, callback, traverseContext) {
  if (children == null) {
    return 0;
  }

  return traverseAllChildrenImpl(children, '', 0, callback, traverseContext);
}

module.exports = traverseAllChildren;

}).call(this,require('_process'))
},{"./ReactElement":52,"./ReactInstanceHandles":60,"./invariant":126,"_process":152}],145:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule warning
 */

"use strict";

var emptyFunction = require("./emptyFunction");

/**
 * Similar to invariant but only logs a warning if the condition is not met.
 * This can be used to log issues in development environments in critical
 * paths. Removing the logging code for production environments will keep the
 * same logic and follow the same code paths.
 */

var warning = emptyFunction;

if ("production" !== process.env.NODE_ENV) {
  warning = function(condition, format ) {for (var args=[],$__0=2,$__1=arguments.length;$__0<$__1;$__0++) args.push(arguments[$__0]);
    if (format === undefined) {
      throw new Error(
        '`warning(condition, format, ...args)` requires a warning ' +
        'message argument'
      );
    }

    if (!condition) {
      var argIndex = 0;
      console.warn('Warning: ' + format.replace(/%s/g, function()  {return args[argIndex++];}));
    }
  };
}

module.exports = warning;

}).call(this,require('_process'))
},{"./emptyFunction":107,"_process":152}],146:[function(require,module,exports){
module.exports = require('./lib/React');

},{"./lib/React":28}],147:[function(require,module,exports){
/**
 * Module dependencies.
 */

var Emitter = require('emitter');
var reduce = require('reduce');

/**
 * Root reference for iframes.
 */

var root = 'undefined' == typeof window
  ? this
  : window;

/**
 * Noop.
 */

function noop(){};

/**
 * Check if `obj` is a host object,
 * we don't want to serialize these :)
 *
 * TODO: future proof, move to compoent land
 *
 * @param {Object} obj
 * @return {Boolean}
 * @api private
 */

function isHost(obj) {
  var str = {}.toString.call(obj);

  switch (str) {
    case '[object File]':
    case '[object Blob]':
    case '[object FormData]':
      return true;
    default:
      return false;
  }
}

/**
 * Determine XHR.
 */

function getXHR() {
  if (root.XMLHttpRequest
    && ('file:' != root.location.protocol || !root.ActiveXObject)) {
    return new XMLHttpRequest;
  } else {
    try { return new ActiveXObject('Microsoft.XMLHTTP'); } catch(e) {}
    try { return new ActiveXObject('Msxml2.XMLHTTP.6.0'); } catch(e) {}
    try { return new ActiveXObject('Msxml2.XMLHTTP.3.0'); } catch(e) {}
    try { return new ActiveXObject('Msxml2.XMLHTTP'); } catch(e) {}
  }
  return false;
}

/**
 * Removes leading and trailing whitespace, added to support IE.
 *
 * @param {String} s
 * @return {String}
 * @api private
 */

var trim = ''.trim
  ? function(s) { return s.trim(); }
  : function(s) { return s.replace(/(^\s*|\s*$)/g, ''); };

/**
 * Check if `obj` is an object.
 *
 * @param {Object} obj
 * @return {Boolean}
 * @api private
 */

function isObject(obj) {
  return obj === Object(obj);
}

/**
 * Serialize the given `obj`.
 *
 * @param {Object} obj
 * @return {String}
 * @api private
 */

function serialize(obj) {
  if (!isObject(obj)) return obj;
  var pairs = [];
  for (var key in obj) {
    if (null != obj[key]) {
      pairs.push(encodeURIComponent(key)
        + '=' + encodeURIComponent(obj[key]));
    }
  }
  return pairs.join('&');
}

/**
 * Expose serialization method.
 */

 request.serializeObject = serialize;

 /**
  * Parse the given x-www-form-urlencoded `str`.
  *
  * @param {String} str
  * @return {Object}
  * @api private
  */

function parseString(str) {
  var obj = {};
  var pairs = str.split('&');
  var parts;
  var pair;

  for (var i = 0, len = pairs.length; i < len; ++i) {
    pair = pairs[i];
    parts = pair.split('=');
    obj[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1]);
  }

  return obj;
}

/**
 * Expose parser.
 */

request.parseString = parseString;

/**
 * Default MIME type map.
 *
 *     superagent.types.xml = 'application/xml';
 *
 */

request.types = {
  html: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  urlencoded: 'application/x-www-form-urlencoded',
  'form': 'application/x-www-form-urlencoded',
  'form-data': 'application/x-www-form-urlencoded'
};

/**
 * Default serialization map.
 *
 *     superagent.serialize['application/xml'] = function(obj){
 *       return 'generated xml here';
 *     };
 *
 */

 request.serialize = {
   'application/x-www-form-urlencoded': serialize,
   'application/json': JSON.stringify
 };

 /**
  * Default parsers.
  *
  *     superagent.parse['application/xml'] = function(str){
  *       return { object parsed from str };
  *     };
  *
  */

request.parse = {
  'application/x-www-form-urlencoded': parseString,
  'application/json': JSON.parse
};

/**
 * Parse the given header `str` into
 * an object containing the mapped fields.
 *
 * @param {String} str
 * @return {Object}
 * @api private
 */

function parseHeader(str) {
  var lines = str.split(/\r?\n/);
  var fields = {};
  var index;
  var line;
  var field;
  var val;

  lines.pop(); // trailing CRLF

  for (var i = 0, len = lines.length; i < len; ++i) {
    line = lines[i];
    index = line.indexOf(':');
    field = line.slice(0, index).toLowerCase();
    val = trim(line.slice(index + 1));
    fields[field] = val;
  }

  return fields;
}

/**
 * Return the mime type for the given `str`.
 *
 * @param {String} str
 * @return {String}
 * @api private
 */

function type(str){
  return str.split(/ *; */).shift();
};

/**
 * Return header field parameters.
 *
 * @param {String} str
 * @return {Object}
 * @api private
 */

function params(str){
  return reduce(str.split(/ *; */), function(obj, str){
    var parts = str.split(/ *= */)
      , key = parts.shift()
      , val = parts.shift();

    if (key && val) obj[key] = val;
    return obj;
  }, {});
};

/**
 * Initialize a new `Response` with the given `xhr`.
 *
 *  - set flags (.ok, .error, etc)
 *  - parse header
 *
 * Examples:
 *
 *  Aliasing `superagent` as `request` is nice:
 *
 *      request = superagent;
 *
 *  We can use the promise-like API, or pass callbacks:
 *
 *      request.get('/').end(function(res){});
 *      request.get('/', function(res){});
 *
 *  Sending data can be chained:
 *
 *      request
 *        .post('/user')
 *        .send({ name: 'tj' })
 *        .end(function(res){});
 *
 *  Or passed to `.send()`:
 *
 *      request
 *        .post('/user')
 *        .send({ name: 'tj' }, function(res){});
 *
 *  Or passed to `.post()`:
 *
 *      request
 *        .post('/user', { name: 'tj' })
 *        .end(function(res){});
 *
 * Or further reduced to a single call for simple cases:
 *
 *      request
 *        .post('/user', { name: 'tj' }, function(res){});
 *
 * @param {XMLHTTPRequest} xhr
 * @param {Object} options
 * @api private
 */

function Response(req, options) {
  options = options || {};
  this.req = req;
  this.xhr = this.req.xhr;
  this.text = this.req.method !='HEAD' 
     ? this.xhr.responseText 
     : null;
  this.setStatusProperties(this.xhr.status);
  this.header = this.headers = parseHeader(this.xhr.getAllResponseHeaders());
  // getAllResponseHeaders sometimes falsely returns "" for CORS requests, but
  // getResponseHeader still works. so we get content-type even if getting
  // other headers fails.
  this.header['content-type'] = this.xhr.getResponseHeader('content-type');
  this.setHeaderProperties(this.header);
  this.body = this.req.method != 'HEAD'
    ? this.parseBody(this.text)
    : null;
}

/**
 * Get case-insensitive `field` value.
 *
 * @param {String} field
 * @return {String}
 * @api public
 */

Response.prototype.get = function(field){
  return this.header[field.toLowerCase()];
};

/**
 * Set header related properties:
 *
 *   - `.type` the content type without params
 *
 * A response of "Content-Type: text/plain; charset=utf-8"
 * will provide you with a `.type` of "text/plain".
 *
 * @param {Object} header
 * @api private
 */

Response.prototype.setHeaderProperties = function(header){
  // content-type
  var ct = this.header['content-type'] || '';
  this.type = type(ct);

  // params
  var obj = params(ct);
  for (var key in obj) this[key] = obj[key];
};

/**
 * Parse the given body `str`.
 *
 * Used for auto-parsing of bodies. Parsers
 * are defined on the `superagent.parse` object.
 *
 * @param {String} str
 * @return {Mixed}
 * @api private
 */

Response.prototype.parseBody = function(str){
  var parse = request.parse[this.type];
  return parse && str && str.length
    ? parse(str)
    : null;
};

/**
 * Set flags such as `.ok` based on `status`.
 *
 * For example a 2xx response will give you a `.ok` of __true__
 * whereas 5xx will be __false__ and `.error` will be __true__. The
 * `.clientError` and `.serverError` are also available to be more
 * specific, and `.statusType` is the class of error ranging from 1..5
 * sometimes useful for mapping respond colors etc.
 *
 * "sugar" properties are also defined for common cases. Currently providing:
 *
 *   - .noContent
 *   - .badRequest
 *   - .unauthorized
 *   - .notAcceptable
 *   - .notFound
 *
 * @param {Number} status
 * @api private
 */

Response.prototype.setStatusProperties = function(status){
  var type = status / 100 | 0;

  // status / class
  this.status = status;
  this.statusType = type;

  // basics
  this.info = 1 == type;
  this.ok = 2 == type;
  this.clientError = 4 == type;
  this.serverError = 5 == type;
  this.error = (4 == type || 5 == type)
    ? this.toError()
    : false;

  // sugar
  this.accepted = 202 == status;
  this.noContent = 204 == status || 1223 == status;
  this.badRequest = 400 == status;
  this.unauthorized = 401 == status;
  this.notAcceptable = 406 == status;
  this.notFound = 404 == status;
  this.forbidden = 403 == status;
};

/**
 * Return an `Error` representative of this response.
 *
 * @return {Error}
 * @api public
 */

Response.prototype.toError = function(){
  var req = this.req;
  var method = req.method;
  var url = req.url;

  var msg = 'cannot ' + method + ' ' + url + ' (' + this.status + ')';
  var err = new Error(msg);
  err.status = this.status;
  err.method = method;
  err.url = url;

  return err;
};

/**
 * Expose `Response`.
 */

request.Response = Response;

/**
 * Initialize a new `Request` with the given `method` and `url`.
 *
 * @param {String} method
 * @param {String} url
 * @api public
 */

function Request(method, url) {
  var self = this;
  Emitter.call(this);
  this._query = this._query || [];
  this.method = method;
  this.url = url;
  this.header = {};
  this._header = {};
  this.on('end', function(){
    var err = null;
    var res = null;

    try {
      res = new Response(self); 
    } catch(e) {
      err = new Error('Parser is unable to parse the response');
      err.parse = true;
      err.original = e;
    }

    self.callback(err, res);
  });
}

/**
 * Mixin `Emitter`.
 */

Emitter(Request.prototype);

/**
 * Allow for extension
 */

Request.prototype.use = function(fn) {
  fn(this);
  return this;
}

/**
 * Set timeout to `ms`.
 *
 * @param {Number} ms
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.timeout = function(ms){
  this._timeout = ms;
  return this;
};

/**
 * Clear previous timeout.
 *
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.clearTimeout = function(){
  this._timeout = 0;
  clearTimeout(this._timer);
  return this;
};

/**
 * Abort the request, and clear potential timeout.
 *
 * @return {Request}
 * @api public
 */

Request.prototype.abort = function(){
  if (this.aborted) return;
  this.aborted = true;
  this.xhr.abort();
  this.clearTimeout();
  this.emit('abort');
  return this;
};

/**
 * Set header `field` to `val`, or multiple fields with one object.
 *
 * Examples:
 *
 *      req.get('/')
 *        .set('Accept', 'application/json')
 *        .set('X-API-Key', 'foobar')
 *        .end(callback);
 *
 *      req.get('/')
 *        .set({ Accept: 'application/json', 'X-API-Key': 'foobar' })
 *        .end(callback);
 *
 * @param {String|Object} field
 * @param {String} val
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.set = function(field, val){
  if (isObject(field)) {
    for (var key in field) {
      this.set(key, field[key]);
    }
    return this;
  }
  this._header[field.toLowerCase()] = val;
  this.header[field] = val;
  return this;
};

/**
 * Remove header `field`.
 *
 * Example:
 *
 *      req.get('/')
 *        .unset('User-Agent')
 *        .end(callback);
 *
 * @param {String} field
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.unset = function(field){
  delete this._header[field.toLowerCase()];
  delete this.header[field];
  return this;
};

/**
 * Get case-insensitive header `field` value.
 *
 * @param {String} field
 * @return {String}
 * @api private
 */

Request.prototype.getHeader = function(field){
  return this._header[field.toLowerCase()];
};

/**
 * Set Content-Type to `type`, mapping values from `request.types`.
 *
 * Examples:
 *
 *      superagent.types.xml = 'application/xml';
 *
 *      request.post('/')
 *        .type('xml')
 *        .send(xmlstring)
 *        .end(callback);
 *
 *      request.post('/')
 *        .type('application/xml')
 *        .send(xmlstring)
 *        .end(callback);
 *
 * @param {String} type
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.type = function(type){
  this.set('Content-Type', request.types[type] || type);
  return this;
};

/**
 * Set Accept to `type`, mapping values from `request.types`.
 *
 * Examples:
 *
 *      superagent.types.json = 'application/json';
 *
 *      request.get('/agent')
 *        .accept('json')
 *        .end(callback);
 *
 *      request.get('/agent')
 *        .accept('application/json')
 *        .end(callback);
 *
 * @param {String} accept
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.accept = function(type){
  this.set('Accept', request.types[type] || type);
  return this;
};

/**
 * Set Authorization field value with `user` and `pass`.
 *
 * @param {String} user
 * @param {String} pass
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.auth = function(user, pass){
  var str = btoa(user + ':' + pass);
  this.set('Authorization', 'Basic ' + str);
  return this;
};

/**
* Add query-string `val`.
*
* Examples:
*
*   request.get('/shoes')
*     .query('size=10')
*     .query({ color: 'blue' })
*
* @param {Object|String} val
* @return {Request} for chaining
* @api public
*/

Request.prototype.query = function(val){
  if ('string' != typeof val) val = serialize(val);
  if (val) this._query.push(val);
  return this;
};

/**
 * Write the field `name` and `val` for "multipart/form-data"
 * request bodies.
 *
 * ``` js
 * request.post('/upload')
 *   .field('foo', 'bar')
 *   .end(callback);
 * ```
 *
 * @param {String} name
 * @param {String|Blob|File} val
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.field = function(name, val){
  if (!this._formData) this._formData = new FormData();
  this._formData.append(name, val);
  return this;
};

/**
 * Queue the given `file` as an attachment to the specified `field`,
 * with optional `filename`.
 *
 * ``` js
 * request.post('/upload')
 *   .attach(new Blob(['<a id="a"><b id="b">hey!</b></a>'], { type: "text/html"}))
 *   .end(callback);
 * ```
 *
 * @param {String} field
 * @param {Blob|File} file
 * @param {String} filename
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.attach = function(field, file, filename){
  if (!this._formData) this._formData = new FormData();
  this._formData.append(field, file, filename);
  return this;
};

/**
 * Send `data`, defaulting the `.type()` to "json" when
 * an object is given.
 *
 * Examples:
 *
 *       // querystring
 *       request.get('/search')
 *         .end(callback)
 *
 *       // multiple data "writes"
 *       request.get('/search')
 *         .send({ search: 'query' })
 *         .send({ range: '1..5' })
 *         .send({ order: 'desc' })
 *         .end(callback)
 *
 *       // manual json
 *       request.post('/user')
 *         .type('json')
 *         .send('{"name":"tj"})
 *         .end(callback)
 *
 *       // auto json
 *       request.post('/user')
 *         .send({ name: 'tj' })
 *         .end(callback)
 *
 *       // manual x-www-form-urlencoded
 *       request.post('/user')
 *         .type('form')
 *         .send('name=tj')
 *         .end(callback)
 *
 *       // auto x-www-form-urlencoded
 *       request.post('/user')
 *         .type('form')
 *         .send({ name: 'tj' })
 *         .end(callback)
 *
 *       // defaults to x-www-form-urlencoded
  *      request.post('/user')
  *        .send('name=tobi')
  *        .send('species=ferret')
  *        .end(callback)
 *
 * @param {String|Object} data
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.send = function(data){
  var obj = isObject(data);
  var type = this.getHeader('Content-Type');

  // merge
  if (obj && isObject(this._data)) {
    for (var key in data) {
      this._data[key] = data[key];
    }
  } else if ('string' == typeof data) {
    if (!type) this.type('form');
    type = this.getHeader('Content-Type');
    if ('application/x-www-form-urlencoded' == type) {
      this._data = this._data
        ? this._data + '&' + data
        : data;
    } else {
      this._data = (this._data || '') + data;
    }
  } else {
    this._data = data;
  }

  if (!obj) return this;
  if (!type) this.type('json');
  return this;
};

/**
 * Invoke the callback with `err` and `res`
 * and handle arity check.
 *
 * @param {Error} err
 * @param {Response} res
 * @api private
 */

Request.prototype.callback = function(err, res){
  var fn = this._callback;
  this.clearTimeout();
  if (2 == fn.length) return fn(err, res);
  if (err) return this.emit('error', err);
  fn(res);
};

/**
 * Invoke callback with x-domain error.
 *
 * @api private
 */

Request.prototype.crossDomainError = function(){
  var err = new Error('Origin is not allowed by Access-Control-Allow-Origin');
  err.crossDomain = true;
  this.callback(err);
};

/**
 * Invoke callback with timeout error.
 *
 * @api private
 */

Request.prototype.timeoutError = function(){
  var timeout = this._timeout;
  var err = new Error('timeout of ' + timeout + 'ms exceeded');
  err.timeout = timeout;
  this.callback(err);
};

/**
 * Enable transmission of cookies with x-domain requests.
 *
 * Note that for this to work the origin must not be
 * using "Access-Control-Allow-Origin" with a wildcard,
 * and also must set "Access-Control-Allow-Credentials"
 * to "true".
 *
 * @api public
 */

Request.prototype.withCredentials = function(){
  this._withCredentials = true;
  return this;
};

/**
 * Initiate request, invoking callback `fn(res)`
 * with an instanceof `Response`.
 *
 * @param {Function} fn
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.end = function(fn){
  var self = this;
  var xhr = this.xhr = getXHR();
  var query = this._query.join('&');
  var timeout = this._timeout;
  var data = this._formData || this._data;

  // store callback
  this._callback = fn || noop;

  // state change
  xhr.onreadystatechange = function(){
    if (4 != xhr.readyState) return;
    if (0 == xhr.status) {
      if (self.aborted) return self.timeoutError();
      return self.crossDomainError();
    }
    self.emit('end');
  };

  // progress
  if (xhr.upload) {
    xhr.upload.onprogress = function(e){
      e.percent = e.loaded / e.total * 100;
      self.emit('progress', e);
    };
  }

  // timeout
  if (timeout && !this._timer) {
    this._timer = setTimeout(function(){
      self.abort();
    }, timeout);
  }

  // querystring
  if (query) {
    query = request.serializeObject(query);
    this.url += ~this.url.indexOf('?')
      ? '&' + query
      : '?' + query;
  }

  // initiate request
  xhr.open(this.method, this.url, true);

  // CORS
  if (this._withCredentials) xhr.withCredentials = true;

  // body
  if ('GET' != this.method && 'HEAD' != this.method && 'string' != typeof data && !isHost(data)) {
    // serialize stuff
    var serialize = request.serialize[this.getHeader('Content-Type')];
    if (serialize) data = serialize(data);
  }

  // set header fields
  for (var field in this.header) {
    if (null == this.header[field]) continue;
    xhr.setRequestHeader(field, this.header[field]);
  }

  // send stuff
  this.emit('request', this);
  xhr.send(data);
  return this;
};

/**
 * Expose `Request`.
 */

request.Request = Request;

/**
 * Issue a request:
 *
 * Examples:
 *
 *    request('GET', '/users').end(callback)
 *    request('/users').end(callback)
 *    request('/users', callback)
 *
 * @param {String} method
 * @param {String|Function} url or callback
 * @return {Request}
 * @api public
 */

function request(method, url) {
  // callback
  if ('function' == typeof url) {
    return new Request('GET', method).end(url);
  }

  // url first
  if (1 == arguments.length) {
    return new Request('GET', method);
  }

  return new Request(method, url);
}

/**
 * GET `url` with optional callback `fn(res)`.
 *
 * @param {String} url
 * @param {Mixed|Function} data or fn
 * @param {Function} fn
 * @return {Request}
 * @api public
 */

request.get = function(url, data, fn){
  var req = request('GET', url);
  if ('function' == typeof data) fn = data, data = null;
  if (data) req.query(data);
  if (fn) req.end(fn);
  return req;
};

/**
 * HEAD `url` with optional callback `fn(res)`.
 *
 * @param {String} url
 * @param {Mixed|Function} data or fn
 * @param {Function} fn
 * @return {Request}
 * @api public
 */

request.head = function(url, data, fn){
  var req = request('HEAD', url);
  if ('function' == typeof data) fn = data, data = null;
  if (data) req.send(data);
  if (fn) req.end(fn);
  return req;
};

/**
 * DELETE `url` with optional callback `fn(res)`.
 *
 * @param {String} url
 * @param {Function} fn
 * @return {Request}
 * @api public
 */

request.del = function(url, fn){
  var req = request('DELETE', url);
  if (fn) req.end(fn);
  return req;
};

/**
 * PATCH `url` with optional `data` and callback `fn(res)`.
 *
 * @param {String} url
 * @param {Mixed} data
 * @param {Function} fn
 * @return {Request}
 * @api public
 */

request.patch = function(url, data, fn){
  var req = request('PATCH', url);
  if ('function' == typeof data) fn = data, data = null;
  if (data) req.send(data);
  if (fn) req.end(fn);
  return req;
};

/**
 * POST `url` with optional `data` and callback `fn(res)`.
 *
 * @param {String} url
 * @param {Mixed} data
 * @param {Function} fn
 * @return {Request}
 * @api public
 */

request.post = function(url, data, fn){
  var req = request('POST', url);
  if ('function' == typeof data) fn = data, data = null;
  if (data) req.send(data);
  if (fn) req.end(fn);
  return req;
};

/**
 * PUT `url` with optional `data` and callback `fn(res)`.
 *
 * @param {String} url
 * @param {Mixed|Function} data or fn
 * @param {Function} fn
 * @return {Request}
 * @api public
 */

request.put = function(url, data, fn){
  var req = request('PUT', url);
  if ('function' == typeof data) fn = data, data = null;
  if (data) req.send(data);
  if (fn) req.end(fn);
  return req;
};

/**
 * Expose `request`.
 */

module.exports = request;

},{"emitter":148,"reduce":149}],148:[function(require,module,exports){

/**
 * Expose `Emitter`.
 */

module.exports = Emitter;

/**
 * Initialize a new `Emitter`.
 *
 * @api public
 */

function Emitter(obj) {
  if (obj) return mixin(obj);
};

/**
 * Mixin the emitter properties.
 *
 * @param {Object} obj
 * @return {Object}
 * @api private
 */

function mixin(obj) {
  for (var key in Emitter.prototype) {
    obj[key] = Emitter.prototype[key];
  }
  return obj;
}

/**
 * Listen on the given `event` with `fn`.
 *
 * @param {String} event
 * @param {Function} fn
 * @return {Emitter}
 * @api public
 */

Emitter.prototype.on =
Emitter.prototype.addEventListener = function(event, fn){
  this._callbacks = this._callbacks || {};
  (this._callbacks[event] = this._callbacks[event] || [])
    .push(fn);
  return this;
};

/**
 * Adds an `event` listener that will be invoked a single
 * time then automatically removed.
 *
 * @param {String} event
 * @param {Function} fn
 * @return {Emitter}
 * @api public
 */

Emitter.prototype.once = function(event, fn){
  var self = this;
  this._callbacks = this._callbacks || {};

  function on() {
    self.off(event, on);
    fn.apply(this, arguments);
  }

  on.fn = fn;
  this.on(event, on);
  return this;
};

/**
 * Remove the given callback for `event` or all
 * registered callbacks.
 *
 * @param {String} event
 * @param {Function} fn
 * @return {Emitter}
 * @api public
 */

Emitter.prototype.off =
Emitter.prototype.removeListener =
Emitter.prototype.removeAllListeners =
Emitter.prototype.removeEventListener = function(event, fn){
  this._callbacks = this._callbacks || {};

  // all
  if (0 == arguments.length) {
    this._callbacks = {};
    return this;
  }

  // specific event
  var callbacks = this._callbacks[event];
  if (!callbacks) return this;

  // remove all handlers
  if (1 == arguments.length) {
    delete this._callbacks[event];
    return this;
  }

  // remove specific handler
  var cb;
  for (var i = 0; i < callbacks.length; i++) {
    cb = callbacks[i];
    if (cb === fn || cb.fn === fn) {
      callbacks.splice(i, 1);
      break;
    }
  }
  return this;
};

/**
 * Emit `event` with the given args.
 *
 * @param {String} event
 * @param {Mixed} ...
 * @return {Emitter}
 */

Emitter.prototype.emit = function(event){
  this._callbacks = this._callbacks || {};
  var args = [].slice.call(arguments, 1)
    , callbacks = this._callbacks[event];

  if (callbacks) {
    callbacks = callbacks.slice(0);
    for (var i = 0, len = callbacks.length; i < len; ++i) {
      callbacks[i].apply(this, args);
    }
  }

  return this;
};

/**
 * Return array of callbacks for `event`.
 *
 * @param {String} event
 * @return {Array}
 * @api public
 */

Emitter.prototype.listeners = function(event){
  this._callbacks = this._callbacks || {};
  return this._callbacks[event] || [];
};

/**
 * Check if this emitter has `event` handlers.
 *
 * @param {String} event
 * @return {Boolean}
 * @api public
 */

Emitter.prototype.hasListeners = function(event){
  return !! this.listeners(event).length;
};

},{}],149:[function(require,module,exports){

/**
 * Reduce `arr` with `fn`.
 *
 * @param {Array} arr
 * @param {Function} fn
 * @param {Mixed} initial
 *
 * TODO: combatible error handling?
 */

module.exports = function(arr, fn, initial){  
  var idx = 0;
  var len = arr.length;
  var curr = arguments.length == 3
    ? initial
    : arr[idx++];

  while (idx < len) {
    curr = fn.call(null, curr, arr[idx], ++idx, arr);
  }
  
  return curr;
};
},{}],150:[function(require,module,exports){
/**
 * @jsx React.DOM
 */

var React = require('react'),
    request = require('superagent');


var BLKPRTY = React.createClass({displayName: 'BLKPRTY',  
  getInitialState: function() {
    return { first: '', last: '', guests: '', submitted: false, total: '', has_first: false, has_last: false, has_guests: false  };
  },

  componentDidMount: function(){
    console.log('Column Editor Mounted');
  },

  // 
  // Text Content Events
  // 
  handleFirst: function(event) {
    if (event.target.value.length > 0) {
      this.setState({has_first: true, first: event.target.value});
    } else {
      this.setState({has_first: false, first: event.target.value});
    }
  },

  handleLast: function(event) {
    if (event.target.value.length > 0) {
      this.setState({has_last: true, last: event.target.value});
    } else {
      this.setState({has_last: false, last: event.target.value});
    }
  },

  handleGuest: function(event) {
    if (event.target.value.length > 0) {
      this.setState({has_guests: true, guests: event.target.value});
    } else {
      this.setState({has_guests: false, guests: event.target.value});
    }
  },

  getTotals: function(){
    var self = this;
    request
      .get('/totals')
      .end(function(res) {
        self.setState({totals: res});
        self.setState({submitted: true});
      }.bind(self));
  },

  printTotals: function(){
    var self = this;
    console.log('people: '+self.state.people);
    console.log('total: '+self.state.total);
    console.log('guests: '+self.state.guests);
  },

  submitContent: function(){
    var self = this;
    if (self.state.first.length && self.state.last.length && self.state.guests.length) {
      request
        .post('/person/new')
        .send(self.state)
        .end(function(res) {
          if (res.ok) {
            var response = JSON.parse(res.text);
            self.setState({guests: response.guests, first: response.first, last: response.last, submitted: true });
          }
        }.bind(self));
      } else {
        if (self.state.first.length == 0) {
          alert('no first name');
        } else if (self.state.last.length == 0) {
          alert('no last name');
        } else if (self.state.guests.length == 0) {
          alert('no guests');
        }
      }
  },

  render: function() {
    var self = this;
    var blk_class = 'blkprty ' + self.state.flicker_class;

    var x = 0;
    var self = this;
    
    function flicker () {
        if (x % 3 === 0) {
                self.setState({flicker_class: '_7 _6 _2'});
                x++;
        } else if (x % 2 === 0) {
                self.setState({flicker_class: '_4 _5 _3 _1'});
                x++;
        } else if (x % 5 === 0) {
                self.setState({flicker_class: '_1 _2 _6 _7'});
                x++;
        } else {
          self.setState({flicker_class: '_1 _2 _3 _4 _5 _6 _7'});
          x++;
        }
    }

    (function loop() {
      var rand = Math.round(Math.random() * (200 - 50)) + 50;
      setTimeout(function() {
              flicker();
              loop();  
      }, rand);
    }());

    if (self.state.guests == 'solo') {
      var thanks_message = "Thanks, see you there. We'll seat you at the rando table.";
    } else if (self.state.guests == 'plus1') {
      var thanks_message = "Thanks, see you and your +1 there.";
    } else if (self.state.guests == 'posse') {
      var thanks_message = "Thanks, see you and your small possé there.";
    } else {
      var thanks_message = '';
    }

    return (
      React.createElement("div", {className: "container"}, 
        React.createElement("div", {className: "blkpresents"}, 
          React.createElement("img", {src: "/images/blk-presents.svg"})
        ), 



        React.createElement("svg", {className: blk_class, version: "1.1", x: "0px", y: "0px", viewBox: "0 0 710 268.5", 'enable-background': "new 0 0 710 268.5"}, 
          React.createElement("g", {id: "BLK_PRTY"}, 
            React.createElement("g", null, 
              React.createElement("path", {fill: "#FFFFFF", d: "M400,143.1c0.3,0.3,0.6,0.8,0.9,0.8c1.2,0.2,2.4,0.2,3.6,0.3c0,0,0,0,0,0.1c0.6,0,1.1,0,1.7-0.1 c0.9-0.2,1.8-1.9,1.3-2.7c-0.6-0.9-1.4-0.4-2-0.1c-1.4,0.9-3,0.9-4.6,1.1C400.5,142.6,400.3,142.9,400,143.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M370.8,85.2c2.4-0.1,4.7-0.4,7.1-0.6c0-0.1,0.1-0.2,0.1-0.2c-4.4-0.9-8.8-1.9-13.2-2.8c0,0.1,0,0.1,0,0.2 c1.5,1,3.1,2,4.6,2.9C369.8,84.9,370.4,85.2,370.8,85.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M399.4,90.3c0.9,0.2,1.9,0.5,2.5,1.1c1.6,1.8,3.1,3.7,4.6,5.6c1.1,1.4,2.3,2.7,2.9,4.3 c1.2,2.9,2.4,5.9,2.4,9.2c0,1.5,0.3,2.9,0.2,4.4c-0.1,1.9-0.4,3.8-0.7,5.7c-0.1,0.6-0.4,1.2-0.4,1.8c-0.2,1.4,0,2.8-0.4,4.1 c-0.5,1.6-1.4,3.1-1.9,4.7c-0.5,1.6-2.5,2.8-1.1,4.9c0.6,0.9,1.2,1.2,2,0.9c2.2-0.9,4.4-1.9,6.7-2.9c0.9-0.4,1.2-1,1.2-1.9 c-0.1-1.6-0.2-3.3-0.2-4.9c0-0.8,0-1.7,0-2.5c0-2-0.2-4-0.1-6c0.1-2,0.3-3.9-0.6-5.8c-0.2-0.4-0.1-1-0.1-1.5 c-0.1-2-0.1-4.1-0.2-6.1c0-0.7-0.2-1.5,0-2.1c0.6-1.4,0.2-2.8,0.1-4.2c-0.1-1.1-0.1-2.2-0.1-3.3c0-1.2,0-2.4,0-3.5 c-0.1-1.9-0.3-3.8-0.4-5.7c0-0.8-0.4-1.2-1-1.4c-1.3-0.4-2.7-0.9-3.6-2.1c-0.1-0.2-0.4-0.3-0.6-0.4c-2.6-0.6-5.2-1.1-7.8-1.7 c-0.8-0.2-1.5-0.4-2.2-0.7c-1.3-0.6-2.6-1.2-3.9-1.8c-0.1,0.1-0.2,0.3-0.3,0.4c0,2.4,0,4.8,0,7.2C396,88.5,397,89.7,399.4,90.3z  M410.2,134.2c-0.1,0.7-0.8,0.8-1.4,0.3c-0.8-0.8-0.7-2.1,0.3-2.8c0.3-0.3,0.8-0.4,1.4-0.8C410.4,132.2,410.4,133.2,410.2,134.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M405.7,136.4c-0.1,0-0.2,0-0.4-0.1c-0.5,0.7-1,1.3-1.6,2c0.1,0.1,0.1,0.2,0.2,0.3c0.6-0.2,1.4-0.3,1.9-0.8 C406,137.7,405.7,136.9,405.7,136.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M441.9,67.8c2,0.6,3,0.3,3.9-1.6c0.6-1.2,0.8-2.6,1.1-4c0.2-0.8-0.2-1.2-1.1-0.8c-1.4,0.6-2.8,1-4.2,1.7 c-0.5,0.3-1,0.8-1.3,1.3c-0.9,1.3,0.1,2.4,0.5,3.6C441.1,68,441.5,67.7,441.9,67.8z M442.4,64.9c0.6-0.3,1.3-0.5,1.9-0.8 c-0.1,0.4-0.3,0.9-0.4,1.3c-0.3,0.6-0.5,0.8-0.5,0.7c-0.1,0-0.4,0-1-0.2c-0.2-0.1-0.3-0.1-0.5-0.1c0-0.1-0.1-0.2,0-0.2 C442.2,65.1,442.4,64.9,442.4,64.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M351.8,83.6c0.7,0.4,1.5,0.5,2.2,0.7c1.3,0.4,2.8,0.7,4,1.4c2.7,1.8,5.4,3.3,8.3,4.5 c2.9,1.2,5.5,2.5,7,5.7c1.5,3.4,3,6.7,3.7,10.4c0.3,1.5,0.7,3,1,4.4c0.2,0.9,0.4,1.9,0.7,2.8c0.1,0.2,0.7,0.4,1,0.3 c0.9-0.3,0.9-1.4,0.1-2c-0.4-0.3-0.7-0.6-1.2-1c1.8-0.5,1.9-0.5,1.7-2.1c-0.2-1.5-0.7-3.1-1.1-4.6c-0.6-2.2-1.3-4.4-2-6.5 c-0.4-1.1-0.7-2.4-1.3-3.4c-1.6-2.4-3-5-5.9-6.2c0,0-0.1-0.1-0.1-0.1c-1-0.9-2.2-1.4-3.6-1.3c-0.4,0-0.9,0-1.4,0 c0.3-1.2,0.3-1.2-0.7-1.6c-0.5-0.2-1-0.6-1.5-0.8c-1.1-0.4-2.2-1.6-3.5-0.5c-0.2,0.2-0.6,0.1-0.9,0.2c0-0.3,0-0.6,0-0.9 c0-0.2,0-0.3,0-0.5c-0.2,0-0.4-0.1-0.6-0.1c-2-0.6-4.3-0.9-6.1-1.9c-1.2-0.7-2.3-1.4-3.8-1.3c-0.8,0-1.5,0.2-2.2,0.3 c0,0.1,0.1,0.3,0.1,0.4C347.9,81.3,349.8,82.5,351.8,83.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M427.8,113.8c-0.4,2.1-0.9,4.2-1.3,6.3c-0.2,1,0.3,1.8,1.3,2.1c0.8,0.2,1.8-0.5,2-1.5 c0.2-1.2,0.1-2.3,0.3-3.5c0.2-1.7-1-2.4-1.8-3.4C428,113.8,427.9,113.8,427.8,113.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M433.3,95.7c0.6,0.4,0.9,0.7,1.4,0.9c0.9,0.4,1.8,1.2,2.7,1.2c1.1,0,2.1-0.5,3.2-0.9 c0.8-0.3,1.2-0.9,0.7-1.8c-0.4-0.7-0.8-1.4-1.2-2.2C437.5,92.9,435.5,94.3,433.3,95.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M435,75.4c0,0.1,0.2,0.2,0.4,0.3c2.6,1.4,5.1,2.7,7.7,4.1c0.3,0.2,0.4,0.6,0.6,1.1 c0.5,1.6,1.3,3.2,1.6,4.8c0.6,3.4,1,6.8,0.6,10.3c-0.3,2.4-0.1,4.8,0,7.2c0,0.6,0.4,1.2,0.6,1.8c0.1,0,0.2,0,0.3,0 c-0.5,0.9-0.3,2.1,0.6,2.5c1,0.4,1.6-0.2,2-1c0.2-0.3,0.3-0.7,0.3-1c0-1.9,0.1-3.8,0-5.7c-0.3-4.3-0.8-8.5-1.1-12.8 c-0.1-1.6,0-3.2-0.8-4.6c-0.2-0.3,0.1-0.7-0.1-1.1c-0.4-1.1-0.6-2.4-1.4-3.2c-0.8-0.9-2-1.3-3-1.9c-1.9-1.1-3.8-2.1-5.8-3.2 c-0.8-0.4-3.5-0.2-4.1,0.4c0,0,0,0.2,0,0.4C434.2,74,435,74.3,435,75.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M404.4,79.2c1.3,0.3,2.6,0.6,3.8,0.9c1.1,0.3,2.3,0.6,3.3,1.2c1.4,0.8,2.6,1.8,4.3,0.7 c0.6,1.3,1.4,2,2.8,1.1c0.1,0,0.2,0.1,0.3,0.1c0.8,0,1.5,0.2,2.3,0.1c3.5-0.4,6.9-0.8,10.4-1.2c0.7-0.1,1.3-0.5,2.1,0 c0.3,0.2,0.9-0.1,1.4-0.2c0.9-0.2,1.8-0.5,2.8-0.7c1-0.1,2-0.1,3.4-0.2c-1-0.5-1.7-0.8-2.3-1.2c-2.2-1.6-4.6-2.6-7.3-3.2 c-1-0.2-2-0.4-3-0.6c-1.8-0.3-3.7-0.8-5.5-0.8c-2.2,0.1-4.4,0.7-6.6,1c-2.7,0.3-5.4,0.6-8.1,0.9c-1,0.1-2,0.1-3,0.3 c-1.1,0.3-2.2,0.8-3.3,1.2c0,0.1,0.1,0.2,0.1,0.4C402.9,78.9,403.7,79.1,404.4,79.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M323.4,120.2c0.2,1.1,0.5,1.5,1.3,1.4c1,0,2-0.3,3-0.5c1.2-0.4,2.3-1.3,3.5-1.2c3.2,0.3,6.4-0.7,9.6,0.1 c0.2,0,0.4,0.1,0.5,0c0.5-0.3,1.2-0.7,1.3-1.1c0.2-1.2,0.2-2.5,0.2-3.8c-0.1-1.6-0.3-3.2-0.3-4.9c-0.1-2.1-0.2-4.2-0.1-6.2 c0.1-2.5,0.5-5.1,0.8-7.5c-0.3-2-0.6-3.8-1-5.6c-0.1-0.4-0.6-0.8-1-1c-0.9-0.4-1.9-0.5-2.8-0.9c-1.7-0.7-3.3-1.4-4.9-2.2 c-2.6-1.4-5.5-1.5-8.3-2.3c-1.5-0.4-2.1,0.1-2.1,1.7c0,2,0,4,0,6c0,4-0.1,8,0,12C323,109.5,322.5,114.8,323.4,120.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M322.8,149.1c-0.2-0.3-0.5-0.6-0.8-0.8c-0.5-0.3-1-0.5-1.4-0.8c-0.3,0.5-0.8,1.1-0.7,1.6 c0,1,2.5,2.4,3.3,2.2c0-0.5,0-1.1,0-1.6C323.1,149.6,322.9,149.3,322.8,149.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M329,160.4c-0.6-0.9-1.2-1.7-2-2.5c-0.8-0.9-1.7-1.7-2.5-2.5c-0.1,0.1-0.2,0.1-0.4,0.2 c0,0.2-0.1,0.5-0.1,0.7c-0.1,1.1-0.1,2.2-0.2,3.3c-0.1,1.3-0.5,2.6-0.5,3.8c0,1.9,0.2,3.9,0.5,5.8c0,0.4,0.3,1.1,0.7,1.2 c0.5,0.2,1.2,0.1,1.7-0.1c0.2-0.1,0.1-0.8,0.1-1.3c0-0.4,0-0.8,0.1-1.2c0.6-1.2,1-2.6,1.9-3.6c0.7-0.8,1-1.6,1-2.5 C329.4,161.3,329.3,160.8,329,160.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M334.9,127.9c-0.3-0.3-0.6-0.6-1-0.9c-0.2,0.4-0.5,0.9-0.9,1.6c0.8-0.1,1.3-0.2,1.7-0.3 C334.8,128.2,334.9,128,334.9,127.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M371.1,124c1.2,0.2,2.4,0.5,3.5,0.6c3.2,0.4,6.4-0.9,8-4.3c0.7-1.5,0.3-3.5-1-4.5 c-0.2-0.2-0.6-0.3-0.8-0.3c-1,0-2.1,0.2-3.1,0.2c-0.7,0-1.1-0.1-1.2-1c-0.1-0.7-0.4-1.5-0.6-2.1c-1.2,0-2.4,0.1-3.5,0 c-1.5-0.1-1.7,0-1.8,1.6c0,0.9-0.2,1.7-0.1,2.6c0.1,1-0.1,2.1,0.8,3c0.4,0.4,0.4,1.4,0.4,2.2C371.7,122.5,371.3,123.2,371.1,124z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M331.1,131.7c-0.8,1.9-1.9,3.7-1.2,5.9c0.5,1.6,0.7,3.3,1.1,4.9c0.1,0,0.3,0.1,0.4,0.1 c0.8-0.9,1.7-1.7,2.3-2.7c1.5-2.5,2.3-5.2,1.4-8.1c-0.2-0.5-0.8-1.3-1-1.2C333.1,131.1,331.7,130.3,331.1,131.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M359.5,156.8c0.9-1,0.7-2,0.2-3.1c-0.4-0.8-0.6-1.7-0.9-2.6c-0.2-0.4-0.4-0.7-0.8-1.3 c-0.6,1.1-1.2,1.9-1.5,2.8c-0.3,1.1-0.5,2.4-0.4,3.5c0.1,0.9,0.5,2.1,2,1.5c0.3-0.1,0.8,0,1.1,0 C359.2,157.3,359.3,157,359.5,156.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M361.6,164.4c-3.4-0.1-6.8-0.3-10.2-0.5c-1.2-0.1-2.4-0.5-3.6-0.4c-1.8,0.1-3.1-0.6-4.3-1.7 c-0.3-0.3-0.6-0.5-1-0.6c-0.8-0.4-1.5-0.7-2.3-1c-1.1-0.5-2.2-1-3.2-1.4c-4.2-3.3-8.7-5.8-12.9-9.2c-0.6,2.3-0.1,3.3,1.4,4.5 c2.3,1.8,4.5,3.8,6.7,5.7c0.8,0.7,1.4,1.5,2.2,2.1c1.7,1.2,3.4,2.2,5.2,3.2c1.1,0.6,2.3,1.1,3.6,1.3c1.4,0.3,2.9,0.3,4.4,0.5 c0.9,0.1,1.8,0.5,2.7,0.5c1.9,0,3.7-0.4,5.6-0.4c3.7,0,7.5,0,11.2,0.2c2.3,0.1,2.8-0.4,2.2-2.6 C366.6,164.4,364.1,164.5,361.6,164.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M336.1,166c-0.4-0.1-0.9-0.4-1.2-0.2c-0.4,0.3-0.9,0.9-1,1.4c-0.3,1.7-0.3,3.4-0.6,5.1 c-0.3,1.5,0,2.2,1.5,2.4c2.5,0.4,4.7,1.4,6.8,2.8c0.7,0.5,1.6,0.7,2.6,1.1c0-3.4,0-6.5,0-9.5c-1.1-0.4-1.8-0.7-2.5-1 C339.9,167.4,338,166.7,336.1,166z M342.3,175.5c-0.3-0.2-0.7-0.4-1-0.6l1,0.3V175.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M366.8,169.1c-1.7,0.9-3.4,0.8-5.2,0.6c-2.3-0.3-4.6-0.9-7-0.7c-2.5,0.2-5-0.1-7.5-0.2 c-0.9-0.1-1.1,0.4-1.1,1.2c0.1,2,0.2,4,0.2,6c0,0.9,0,1.9,0,2.9c1.7-0.2,3.1-0.3,4.6-0.4c2.7-0.2,5.5-0.3,8.2-0.7 c2.6-0.3,5.2-0.9,7.9-1.3c1.9-0.3,2-0.2,2.2-2.1c0.1-1.8,0-3.6,0-5.6C368.2,168.8,367.4,168.8,366.8,169.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M330.4,165.6c-0.9,0.3-2,3.2-1.8,4.1c0.2,0.7-0.1,1.6,0,2.4c0,0.6,0.3,1.1,0.5,1.7 c0.5-0.1,1.1-0.2,1.4-0.5c1.6-1.6,1.5-3.9,1.8-5.5C332.4,166.1,331.4,165.3,330.4,165.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M380.7,99.9c-0.2,0.2-0.5,0.4-0.4,0.6c0.2,0.8,0.5,1.5,0.7,2.2c0.2,0,0.3-0.1,0.5-0.1 c-0.1-0.7-0.2-1.5-0.3-2.2C381.1,100.2,380.9,100.1,380.7,99.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M353.6,118.8c0.6,0,1.5,0.4,1.2-1.4c-0.6,0.4-1,0.8-1.4,1.1C353.4,118.5,353.5,118.6,353.6,118.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M325.9,147.1c-0.1,0.4-0.1,1.1,0.2,1.3c1.2,0.8,2.5,1.5,3.6,2.2c0.6-0.5,0.9-0.8,1.3-1.2 c0.2,0.5,0.5,1,0.7,1.6c0.1,0.4,0.1,0.9,0.3,1.1c1.1,1,2.1,1.9,3.7,2c0.8,0,2.2,0.3,2.4,0.9c0.4,1,1.1,1.3,1.8,1.8 c1.1,0.7,2.3,1.4,3.7,2.1c0-1.5,0.1-2.8,0-4c-0.1-1.6-0.4-3.2-0.5-4.7c-0.2-2.6-0.2-5.2-0.3-7.8c0-1.4,0-2.8,0-4.1 c-0.1-1.8-0.3-3.5-0.4-5.3c-0.1-1.6,0-3.2,0-4.8c0-0.3-0.2-0.8-0.4-0.8c-1.2-0.4-2.4-0.7-3.7-0.9c-0.3-0.1-1,0.4-1,0.6 c-0.2,1.2-0.3,2.5-0.1,3.7c0.6,3.5,0.4,6.9-1.6,9.9c-1.1,1.6-2.5,3-3.8,4.6c-0.5,0.6-0.9,1.1-1.3,1.7c-0.2-0.1-0.4-0.2-0.5-0.2 c-0.2-0.7-0.5-1.3-0.7-2c-0.4-1.7-0.5-3.6-1.1-5.2c-0.9-2.8-0.1-5.2,1.2-7.5c0.7-1.3,0.9-2.5,1-4c-1.8,0.4-3.4,0.8-5.1,1.2 c-0.6,0.1-1,0.3-1.1,1.1c-0.1,2.4-0.4,4.7-0.4,7.1c0,2,0.1,3.9,0.2,5.9c0,0.7,0,1.5,0.1,2.2c0,0.2,0.2,0.4,0.5,0.9 c0.4-0.9,0.7-1.6,0.9-2.3c0.2-0.5,0.4-1.2,1.1-0.9c0.6,0.3,1,0.8,0.7,1.6C326.7,145.4,326.2,146.2,325.9,147.1z M334.4,145.3 c1.4,0.2,1.6,1.6,2.1,2.6c0.2,0.4,0.3,0.9,0.2,1.4c0,0.3-0.2,0.6-0.4,0.7c-0.2,0.1-0.8,0-0.8-0.2c-0.6-1.4-1-2.9-1.6-4.3 C334.1,145.5,334.3,145.4,334.4,145.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M357.1,119c0.6,0,1.1,0,1.6,0c2.6-0.2,5.1-0.5,7.7-0.6c1,0,1.6-0.3,1.7-1.4c0.1-1.3,0.3-2.5,0.3-3.8 c0-1.4,1.3-3,2.6-3.1c1.4-0.1,2.8-0.1,4.4-0.2c-0.1-0.5-0.1-0.9-0.3-1.3c-0.4-1.3-1-2.6-1.1-4c-0.5-3.5-1.5-6.8-3.9-9.6 c-1.2-1.4-2.5-2.6-4.3-3.1c-1.1-0.3-2.2-0.7-3.1-1.3c-2.1-1.5-4.4-2.4-7-1.9c-0.9,0.2-1.9,0.3-2.8,0.4c-1.9,0.2-3.9,0.3-5.8,0.4 c-2.1,0.1-3.1,0.6-2.7,3c0.1,0.6,0.3,1.2,0.3,1.8c0,2.2,0,4.4-0.1,6.6c-0.1,1.5-0.5,3.1-0.4,4.6c0.1,3.3,0.5,6.6,0.7,9.9 c0.1,0.9,0.3,1.9,0.2,2.8c-0.2,1.3,0,1.6,1.3,1.6c0.9,0,1.7,0,2.6-0.1c0.6-0.1,1.5-0.3,1.6-0.6c0.2-0.5-0.2-1.3-0.4-1.9 c-0.3-0.8-1-1.6-1.1-2.4c-0.5-3.9,1-7.4,2.5-10.8c0.8-1.8,2.1-1.7,3.2-0.1c1.4,2,2.5,4.1,3.2,6.5c0.5,1.6,0.4,3.2-0.6,4.6 C356.6,116.4,356.9,117.6,357.1,119z M348.8,105.9c-0.3,0.1-0.9-0.3-1.3-0.7c-0.4-0.4-0.9-0.9-1.1-1.4c-0.1-0.4,0.1-0.9,0.2-1.4 c0.4,0.1,0.9,0.2,1.2,0.4c0.4,0.2,0.8,0.5,1.1,0.8c0.3,0.2,0.5,0.6,0.8,1C349.4,105.1,349.1,105.8,348.8,105.9z M351.8,101.8 c-0.2,0-0.7-0.2-0.7-0.4c-0.3-1.4-0.6-2.7-0.8-4.1c0-0.3,0.2-0.6,0.4-0.8c0.2-0.1,0.4-0.2,0.5-0.3c0.2,0.4,0.5,0.7,0.6,1.1 c0.3,1.3,0.5,2.6,0.6,3.9C352.3,101.3,352,101.8,351.8,101.8z M357.2,103.6c-0.4,0.5-1,0.3-1.2-0.5c-0.1-0.8,0.9-2.9,1.6-3.2 c0.6-0.3,1.2,0.1,1.4,1C358.4,101.8,357.9,102.8,357.2,103.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M356,113.1c-0.1-2.5-1.3-4.6-3.1-6.6c-0.7,1.9-1.3,3.6-1.8,5.3c-0.1,0.2,0,0.5,0,0.7 c0.2,0.8,0.1,2,0.6,2.4c0.5,0.4,1.6,0.2,2.4,0.2C355.3,115.2,356.1,114.4,356,113.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M324.9,126.7c0.2,0.1,0.4-0.1,0.7-0.2c1.5-0.3,3-0.7,4.5-1c1.4-0.3,2.9-0.3,4.2-0.7c3-1,6-0.2,9,0.1 c1.8,0.2,3.7,0.6,5.5,0.8c1.2,0.1,2.4-0.1,3.7-0.1c1.2-0.1,2.4-0.1,3.6-0.2c1.5-0.2,3.1-0.7,4.6-0.5c2.8,0.4,5.2-0.6,7.7-1.2 c0.4-0.1,0.8-0.9,0.9-1.4c0-0.2-0.6-0.8-1-0.9c-1.6-0.2-3.2-0.3-4.8-0.3c-1.1,0-2.2,0.2-3.3,0.3c-1.9,0.2-3.8,0.5-5.7,0.7 c-1.5,0.1-3,0.1-4.5,0.2c-2.3,0.1-4.6,0.4-6.8,0.5c-2.7,0-5.4-0.1-8.1-0.2c-1.3,0-2.5,0.4-3.7,1c-1.4,0.7-2.9,1.3-4.7,0.8 c-1.1-0.3-2.4,0-3.6,0c-0.6,0-1.3,0-1.9,0c-0.1-0.1-0.3-0.1-0.4-0.2c0,0.5-0.2,1.1-0.1,1.6c0.1,0.3,0.5,0.6,0.8,0.7 C322.6,126.5,323.8,126,324.9,126.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M443,84c-0.1-0.2-0.4-0.6-0.6-0.6c-2.1-0.2-4.1-0.5-6.2,0.2c-1,0.4-2.1,0.7-3.2,0.8 c-2.9,0.2-5.8,0.2-8.7,0.6c-2.1,0.2-4.2,0.8-6.3,1.2c-0.1,1-0.2,1.8-0.2,2.6c0.2,5.3,0.4,10.6,0.7,15.9c0.1,1.3,0.1,2.7,0.2,4 c0.2,2.7,0.7,5.3,0.8,8c0.1,3.6,0,7.2,0,10.8c0,1.3,0.3,2.5,0.5,4.1c1.1-0.7,1.9-1.3,2.7-1.8c1.5-0.8,3-1.6,4.4-2.5 c0.4-0.2,0.9-0.9,0.8-1.2c-0.3-0.8-0.7-1.6-1.3-2.3c-1.2-1.3-2.6-2.3-2.8-4.4c-0.2-1.4-0.6-2.6,0.1-4c0.3-0.6,0.6-1.3,0.8-1.9 c0.3-0.9,0.4-1.7,0.5-2.2c-1.2-0.6-2.1-1-3-1.5c-0.2-0.1-0.2-0.8-0.1-1.2c0.1-0.2,0.7-0.4,1-0.3c0.8,0.2,1.5,0.6,2.3,1 c1.1-1.7,2.2-1.6,3.2,0.3c0.4,0.8,0.9,1.6,1.5,2.1c2.3,2.1,3,4.7,2.1,7.6c-0.5,1.9,0.7,3.1,1,4.8c2.6-1.4,5.1-2.8,7.5-4.2 c0.9-0.5,1.1-1.3,1-2.4c-0.3-3.2-0.5-6.4-0.6-9.7c-0.1-1.6,0.6-2.2,2-2.8c0.3-0.1,0.6-0.6,0.6-0.9c0.2-2.3,0.3-4.5,0.4-6.8 c-0.1-0.1-0.3-0.2-0.4-0.3c-0.4,0.2-0.9,0.4-1.3,0.7c-1.6,1.2-3.4,2-5.4,1.9c-0.7,0-1.4-0.4-2.1-0.8c-1.7-0.8-3.3-1.7-4.9-2.7 c-0.4-0.3-0.6-0.9-0.9-1.3c0.4-0.3,0.8-0.5,1.3-0.8c1.6-0.8,3.2-1.6,4.8-2.3c0.9-0.4,1.8-0.8,2.8-1c2-0.4,4-0.6,6.3-0.9 C443.8,87.9,443.4,86,443,84z M424.8,107.3c-0.3-0.5-0.7-1-0.8-1.6c-0.1-0.7,0.3-1.6,1.1-1.6c0.5,0,0.8,0.9,1.5,1.6 C425.9,106.4,425.4,106.8,424.8,107.3z M423.4,96.4c-0.3-2.1,0.5-2.6,3.3-2.2C427,95.6,426.9,95.7,423.4,96.4z M431.8,105.9 c-0.3,0.4-0.3,1.1-0.4,1.6c0,0.2,0,0.3,0,0.5c0,0.9-0.7,2-1.2,1.7c-0.5-0.2-0.7-1-1-1.4c0.2-1.1,0.4-1.9,0.6-2.6 c0.2-0.7,0.6-1,1.3-0.9C432,104.8,432.5,104.9,431.8,105.9z M431.3,98.1c0.5,1.7-0.4,3.3-1.6,3.7c-0.3,0.1-0.9,0.1-1-0.1 c-0.2-0.3-0.2-0.9,0-1.1C429.5,99.7,430.4,98.9,431.3,98.1z M431.2,91c-0.1,0.4-0.9,1-1,0.9c-0.7-0.4-2.1,0-2-1.3 c0-0.4,0.7-0.9,0.8-1.1C430.4,89.6,431.4,90.3,431.2,91z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M337.4,86.1c1.2,0.1,2.7,0.5,3.6,1.3c1.1,1,2.2,0.7,3.3,0.6c2-0.1,4-0.3,6-0.5c1.4-0.2,2.9-0.5,4.3-0.7 c0-0.1,0-0.2,0-0.2c-0.2-0.1-0.4-0.3-0.6-0.3c-2.5-0.2-4.5-1.5-6.5-2.7c-1.7-1.1-3.4-2.3-5.5-2.4c-1-0.1-1.9,0.2-2.9,0.2 c-2.2,0-4.5,0-6.7,0c-1.3,0-2.6,0.2-4.1,1.1c1.1,0.5,2,0.9,2.8,1.3C333.1,84.8,335,86,337.4,86.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M611.4,93.5c-0.8,2.1-0.4,4.2,1,6.3c0.4-0.5,0.8-0.8,1-1.1c1.1-1.6,2.3-3.1,1.4-5.2 c-0.3-0.6-1-1.5-1.4-1.4C612.7,92.3,611.6,92.8,611.4,93.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M596.4,101.1c-0.1-0.2-0.1-0.4,0-0.6c0.7-1.5-0.5-2.4-0.9-3.7c-0.3,0.2-0.4,0.3-0.4,0.4 c-0.9,3.9-1.8,7.8-1.1,11.8c0,0.3-0.1,0.6-0.2,0.9c-0.4,0.9-0.9,1.8-1.1,2.8c-0.5,2.8-2,5.1-3.5,7.4c-1.5,2.2-4,3.3-6.1,4.7 c-0.4,0.3-1,0.9-0.9,1.1c0.2,0.6,0.7,1.3,1.2,1.4c2.3,0.5,4.3-0.6,5.9-2.1c2-1.9,3.2-4.3,4.6-6.6c1.7-2.8,2.5-5.7,2.4-8.9 c0-0.5,0-1.1,0.1-1.6C596.5,105.7,597.3,103.5,596.4,101.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M614.1,89.3c-0.1-0.3-0.1-0.8-0.2-0.8c-0.5-0.2-1.1-0.3-1.6-0.4c-0.1,0.1-0.1,0.3-0.2,0.4 c0.4,0.3,0.7,0.7,1.2,1C613.5,89.5,613.8,89.3,614.1,89.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M356.3,161.3c0.2,0.3,0.5,0.6,0.8,1c0.6-0.5,1.1-0.9,1.6-1.2c-0.4-0.2-0.8-0.7-1.1-0.7 C357.2,160.5,356.8,161,356.3,161.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M585.2,72.9c-0.4,0.8,0.2,1.3,0.7,1.6c1.2,1,2.1,2.7,4,2.6c0.2,0,0.4,0.2,0.6,0.3c1.5,1,3,2,4.5,2.9 c0.9,0.6,1.9,1,2.9,1.5c1.4,0.7,2.9,1.3,4.2,2.1c2.3,1.5,4.6,2.4,7.4,1.4c1-0.4,2.4-0.2,3.5-0.1c1.4,0.1,2.8,0.4,4.3,0.4 c1.8,0.1,3.7-0.2,5.5,0c1.3,0.1,2.5,0.2,3.5-0.8c0.2-0.2,0.5-0.2,0.8-0.2c0.8-0.2,1.6-0.3,2.5-0.5c0.9-0.2,1.1-0.8,0.8-1.6 c-0.6,0-1.2,0.1-1.8,0.1c-1.7,0.1-3.3-0.1-4.9,0.3c-1.3,0.3-2.5,0.5-3.8,0.3c-0.4-0.1-0.8-0.3-1.2-0.2c-2.4,0.2-4.9,0.6-7.3,0.7 c-1.6,0-3.1-0.4-4.7-0.7c-0.2,0-0.4-0.4-0.6-0.6c-0.8-0.6-1.6-1.5-2.5-1.8c-2.1-0.6-3.6-2-5.3-3.1c-1-0.6-2-2-2.8-1.9 c-2,0.3-3.1-0.9-4.4-1.9c-0.7-0.5-1.5-0.8-2.3-1.3c-0.9-0.6-1.7-1.3-2.7-1.7c-0.4-0.2-1.1,0.1-1.6,0.2c0.1,0.5,0.2,1,0.4,1.4 C584.9,72.4,585.2,72.7,585.2,72.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M587.9,134.2c0.4,0.6,0.8,1.2,1,1.9c0.5,1.5,1.6,2.1,3.2,2.5c0.4-2.6-0.3-4.5-2.1-6.2 c-0.6-0.5-1-0.8-1.6-0.2C587.9,132.8,587.1,133.2,587.9,134.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M583.4,139c0-0.5-0.2-1-0.3-1.5c0,0,0.1,0,0.1,0c-0.3-1.9-0.5-3.8-0.9-5.7c-0.2-0.9-0.7-1.9-1.9-1.7 c-1.6,0.2-3.3,0.7-4.9,1c-0.9,0.2-1.8,0.4-2.7,0.6c-2.6,0.5-5.3,1.1-8,1.4c-1.4,0.2-1.6,0.9-1.5,2c0.1,1.1,0.3,2.1,0.5,3.2 c0.2,1.3,0.5,2.5,0.7,3.8c0,0.1-0.1,0.3-0.2,0.4c-0.6,1.1-0.5,2.3,0.6,3c1.4,0.8,2.9,1.5,4.4,2.2c0.3,0.1,0.8,0.1,1.1-0.1 c0.1-0.1,0.1-0.7,0-1c-0.7-2.1-1.4-4.1-2-6.2c-0.1-0.4,0-1,0.2-1.4c0.6-1.5,1.1-3,1.8-4.4c0.2-0.4,0.7-0.8,1.1-1.1 c0.6-0.3,0.9,0.2,1.2,0.8c0.3,0.6,0.8,1.2,1.3,1.7c2.1,1.9,2.8,5,1.5,7.6c-0.3,0.5,0.1,3.2,0.6,3.6c0.2,0.2,0.5,0.2,0.8,0.2 c1.8-0.3,3.6-0.6,5.4-0.9c0.6-0.1,1.1-0.4,1-1.1c-0.1-1-0.2-2.1-0.3-3.1c0-0.3,0-0.6,0-0.9C583.2,140.4,583.4,139.7,583.4,139z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M410.6,155.8c0,0.2,0.5,0.4,0.8,0.7c0.1-0.1,0.2-0.1,0.3-0.2c-0.1-0.5-0.2-1-0.2-1.5c-0.1,0-0.3,0-0.4-0.1 C410.9,155.1,410.6,155.5,410.6,155.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M590.5,109.1c-0.5,0.2-0.9,0.7-1.3,1.1c0.5,0.5,0.9,1,1.4,1.5c0.3-0.5,0.7-1,1.2-1.7 C591.2,109.5,590.7,109,590.5,109.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M585.2,130.5c0.1,0.3,1.3,0.6,1.7,0.4c1.1-0.6,0.1-1.3-0.1-2.1C585.8,129,584.9,129.3,585.2,130.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M589.9,71c1,0.7,1.6,0.6,2-0.6c0.2-0.7,0.3-1.4,0.6-2.1c0.3-0.8,0-1.2-0.7-1.4c-0.9-0.3-1.8-0.5-2.7-0.8 c-1.6-0.5-2.3,0-2.4,2c0.1,0.1,0.2,0.5,0.5,0.8C588.1,69.7,589,70.3,589.9,71z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M541.9,156.4c2,0.7,4.1,0.7,6.2,0.2c0-1.8-1.4-2.7-2.5-3.2c-1-0.4-2.4,0.1-3.6,0.1c-1,0-1.3,0.7-1.1,1.5 C541,155.6,541.4,156.3,541.9,156.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M392,153.7c-1.1,0.2-2.3,0.5-3.6,0.9c0.9,1,1.4,1.9,2.2,2.5c0.6,0.5,1.5,0.8,2.2,0.7 c1.6-0.2,0.9-1.6,0.8-2.5C393.6,154.1,393.1,153.5,392,153.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M543,119c1.6,0.5,5.5-1.1,6.3-2.6c0.3-0.6,0.2-1.1-0.4-1.2c-1-0.2-2-0.3-2.9-0.4c0,0,0,0.1,0,0.1 c-0.5,0-1,0-1.6,0c-1-0.1-1.6,0.5-1.9,1.3C541.9,117.4,542.2,118.8,543,119z M544.2,117c0,0,0-0.1,0-0.1c0.2,0,0.4,0,0.6,0 C544.6,117,544.4,117,544.2,117C544.2,117,544.2,117,544.2,117z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M377.4,166.3c1.5,0.6,3,1.2,4.6,1.7c1.4,0.2,1.9-1.1,2.7-1.8c0.6-0.5,0.5-1.1-0.1-1.5 c-2.1-1.4-4.4-1.4-6.6-0.6c-0.4,0.1-0.6,0.9-0.8,1.3C377,165.7,377.2,166.2,377.4,166.3z M382.2,165.9 C382.2,166,382.2,166,382.2,165.9l-0.7-0.2c0,0,0,0,0,0C381.8,165.8,382,165.9,382.2,165.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M615.4,71.5c-1.4,0.1-2.7,0.4-4.1,0.2c-2.2-0.3-3.4,0.5-3.6,2.8c0,0.4-0.2,0.7-0.3,1 c-0.6,1.2-1.2,2.5-1.9,3.9c1.3,0.7,2.6,1.9,4,2.1c2.3,0.3,4.8,0.1,7.2,0c3.3-0.2,6.6-0.6,9.8-0.8c1-0.1,1.9-0.4,2.3-1.4 c0.6-1.6,1-3.3,2-4.7c1-1.4,0.8-2.8,1.2-4.5c-0.6,0.1-1,0.1-1.4,0.2c-3.6,0.4-7.1,0.7-10.7,1.1C618.4,71.4,616.9,71.5,615.4,71.5z "}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M603.1,78.3c0.7,0.4,1-0.2,1.2-0.8c0.2-0.9,0.4-1.8,0.6-2.7c0.5-2,0-3.1-1.7-4.2c-0.6-0.4-1.2-0.8-1.9-1.1 c-0.3-0.2-0.8-0.2-1.1-0.1c-0.2,0.1-0.3,0.7-0.2,1c0.5,1.9-0.2,3.3-1.6,4.8C600,76.3,601.5,77.3,603.1,78.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M601.5,67.7c0.9,0.1,1.7,0.7,2.5,1.2c1.5,0.9,2.7,1.5,4.7,1.1c3-0.6,6.2-0.4,9.3-0.6 c0.8,0,1.6-0.1,2.4-0.2c0.8-0.1,1.9-0.6,2.4-0.2c1,0.6,1.8,0.2,2.7,0.1c0.8-0.2,1.6-0.4,2.3-0.6c0-0.1,0-0.2-0.1-0.3 c-0.4-0.1-0.7-0.3-1.1-0.4c-1.7-0.3-3.4-0.5-5-1c-2-0.6-4-1.5-6-2.3c-1.6-0.7-3.2-1.4-5-1.3c-3.3,0.3-6.6,0.6-9.9,0.9 c-0.8,0.1-1.6,0.2-2.5,0.4C599,66,599.5,67.5,601.5,67.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M596.9,73.1c0.3-0.6,0.9-1.3,0.8-1.7c-0.5-1.5-1.2-2.8-1.9-4.3c-0.2,0-0.4,0-0.6,0c-0.3,1-0.7,2.1-0.7,3.1 c0,0.7,0.6,1.4,1.1,2C595.9,72.5,596.4,72.8,596.9,73.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M571.7,137.6c-1.1,1-0.9,4,0.3,4.9c0.3,0.2,1.1,0.1,1.4-0.2c0.4-0.3,0.5-1,0.8-1.8 c-0.4-0.9-0.9-1.9-1.5-2.9C572.6,137.5,571.8,137.4,571.7,137.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M496.9,79c-1.9,0.1-3.7,0-5.6-0.1c-1.2-0.1-1.6,0.3-1.4,1.5c0.1,0.5,0.2,1,0.2,1.4c0,2.9,0,5.8,0,8.7 c0,2.2,0.1,4.3,0.2,6.5c0.1,1.3,0.3,2.7,0.4,4c0,0.2,0.3,0.5,0.3,0.5c0.9-0.3,1.3,0.4,2,0.7c2.1,0.9,3.6,0.2,4.2-2 c0.8-3.1,1.5-6.3,1.8-9.4c0.3-3.2,0.1-6.4,0.1-9.6C499.4,79,499.1,78.9,496.9,79z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M470.2,83.1c2.2,1,4.4,2.2,5.4,4.8c0.1,0.3,0.8,0.4,1.2,0.7c0.4,0.3,0.9,0.6,1.2,1c0.6,0.9,1,1.9,1.5,2.9 c0.5,1,0.9,2,1.4,2.9c1.4,2.7,2.4,5.7,5.8,6.6c0.9,0.3,1.1,0.1,1.4-0.7c0.4-1.2,0.2-2.4,0.1-3.7c-0.3-4.6-0.4-9.2-0.6-13.8 c0,0,0,0,0.1,0c0-1.1,0.1-2.1,0-3.2c-0.1-0.5-0.4-1.2-0.7-1.3c-1.7-0.7-3.5-1.3-5.3-1.8c-1.3-0.4-2.6-0.5-3.8-0.9 c-2.7-0.8-5.3-1.8-7.9-2.6c-1.2-0.4-2.2,0.2-2.2,1.5c0,1.1,0.1,2.2,0,3.2C467.1,81,468.2,82.1,470.2,83.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M455.7,107.3c-0.1,0-0.1-0.1-0.1-0.2c-0.8-0.9-3.2-1.1-3.8-0.3c-0.4,0.5-0.9,1.1-1.4,1.6 c-2,1.8-2.3,1.8-4.5,0.4c-0.6-0.4-1.4-0.4-2-0.6c-0.1,0.7-0.4,1.5-0.4,2.2c0.1,1.5,0.4,2.9,0.6,4.4c-0.1,0-0.1,0-0.2,0 c0,0.5,0,1.1,0,1.6c0,0.8,0.3,1.1,1,1c1.6-0.3,2.6,0.7,3.7,1.5c0.3,0.2,0.8,0.4,1.3,0.4c2.4,0,4.3-1.3,6.2-2.5 c0.5-0.3,1.2-1,1.2-1.4C457.2,112.5,458.9,109.4,455.7,107.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M482.9,75.5c2.3,0.7,5,0.4,7,2.3c0.1,0.1,0.4,0.1,0.6,0.1c2.2-0.9,4.4-0.7,6.7-0.4 c1.6,0.3,2.2-0.6,1.6-2.2c-0.1-0.4-0.4-0.7-0.8-0.9c-0.4-0.3-1.2-0.5-1.4-0.9c-1.1-2-3.2-1.6-4.7-1.7c-2.5-0.1-5,0.7-7.5,1.1 c-0.3,0.1-0.7,0.1-1.1,0.1c-1,0-2.1-0.1-3.1-0.1c-1.2,0.1-2.4,0.3-3.9,0.5c0.5,0.4,0.6,0.6,0.8,0.6 C479.1,74.5,481,74.9,482.9,75.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M451.9,79.8c-1-0.2-1.6-0.3-2.5-0.5C450,80.7,450.4,80.8,451.9,79.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M414.4,156.5c0.2,0.1,0.4,0.1,0.6,0.2c0.7,0.1,1.5,0.3,2.2,0.4c1,0.2,1.4-0.2,1.3-1.2 c-0.1-1.4-0.2-2.7-0.2-4.1c0-2.9,0.1-5.7,0.1-8.6c0-0.6-0.2-1.2-0.3-2c-1.6,0.7-3,1.2-4.4,1.8c-0.6,0.3-0.9,0.7-0.4,1.4 c2,2.7,1.6,5.4,0,8.1C413.2,152.9,413.9,156.2,414.4,156.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M411.4,145.1c-0.5-0.7-2.5-0.3-2.7,0.5c-0.4,1.7-0.8,3.4,0.1,5.2c0.6,1.1,1.8,1.5,2.5,0.4 c0.6-0.9,1-2.1,1.5-3.2C412.3,146.9,411.9,145.9,411.4,145.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M426.7,132.6c0.8-1.3,2.1-1.8,3.3-2.4c0.4-0.2,0.9-0.2,1.2-0.4c2-1.2,4-2.5,6-3.8c1.2-0.8,2.5-1.6,3.7-2.5 c1.6-1.1,3.2-2.2,4.8-3.4c0.2-0.1,0.2-0.4,0.3-0.8c-0.8-0.1-1.6-0.1-1.6,0.8c0,1.2-0.7,0.8-1.3,0.8c-0.4,0-0.8-0.2-1.1-0.1 c-2.4,1.4-4.8,2.9-7.2,4.4c-1,0.6-2,1.3-3.1,1.9c-1.9,1-3.9,1.9-5.7,2.9c-1,0.5-1.8,1.3-2.7,2c-1.4,1.1-2.8,2.1-4.2,3.2 c-0.3,0.2-0.6,0.5-0.9,0.6c-2.5,1.2-5.1,2.4-7.6,3.6c-1.1,0.5-1.1,0.9-0.3,1.8c0.8-0.2,1.5-0.4,2.2-0.6c1-0.2,2.1-0.3,3-0.8 c3-1.5,6-2.9,8.6-5.2C425,134,426.1,133.5,426.7,132.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M423.9,149.8c0.6,0.5,1.1,0.4,1.3-0.5c0.3-1.2,0.5-2.4,0.7-3.1c0-2.1-1.1-3.5-2.6-3.8 c-1.1-0.2-2,0.6-1.8,1.8c0.1,0.5,0.2,1.1,0.2,1.6C421.4,147.7,422.6,148.8,423.9,149.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M535.7,59.1c1.9,0.4,3.3-0.8,3.4-2.8c0-0.8,0-1.6,0.1-2.5c0-1,0.1-1.9,0.2-3.1c-2.2,1.9-4,3.6-5.9,5.3 c-0.9,0.8-1,2-0.5,2.7C534,58.9,534.9,59,535.7,59.1z M537.1,55.5c0,0.2,0,0.4,0,0.7l0,0.2c0,0.6-0.2,0.9-0.7,0.9 c-0.1,0-0.2,0-0.3,0c-0.3-0.1-0.5-0.1-0.8-0.1L537.1,55.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M581.8,102.5c-0.6,2.2,0.6,3.4,1.6,4.8c0.6,0.7,1,0.9,1.9,0.6c0.8-0.3,1.6-0.3,2.7-0.4 c0.4-0.6,0.2-1.3-0.3-2.2C586.5,102.6,583.9,103.2,581.8,102.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M535.7,71.9c0.1,1.7,0.1,1.7,1.8,1.7c1.7,0,3.4-0.2,5.2-0.2c1.5-0.1,3.1,0.1,4.5-0.1 c2.5-0.5,5-0.4,7.5-0.1c1.3,0.2,2.6,0.4,3.9,0.3c2.4-0.1,4.7-0.2,7.1-0.4c1.1-0.1,2.3-0.2,3.4-0.4c1.8-0.3,3.5-0.6,5.5-0.9 c-3-1.3-5.8-2.6-8.7-3.8c-0.5-0.2-1.1-0.5-1.4-0.3c-1.3,0.7-2.2,0-3.1-0.7c-0.4-0.3-1-0.7-1.5-0.7c-2.6-0.1-5.3-0.1-7.9,0 c-3.3,0.1-6.6,0.5-9.9,0.6c-1.9,0.1-3.8-0.1-5.6-0.2c-0.6,0-1,0-0.9,0.9C535.5,68.9,535.6,70.4,535.7,71.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M601.1,86.4c0.1-0.2-0.1-0.6-0.4-0.8c-0.3-0.2-0.7-0.4-1.1-0.5c-2.6-0.9-5-2.1-7.1-3.9 c-1.1-0.9-2.3-2-4.2-1.9c0.7,1.3,1.4,2.5,2,3.7c1.1,2,2.2,4,3.3,5.9c0.2,0.3,0.4,0.6,0.7,0.6c1.5,0.5,2.9,0.9,4.4,1.4 C599.6,89.6,600.4,88,601.1,86.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M562.2,75.2c-1.3-0.1-2.6,0.1-4.1,0.2c0.3,0.9,0.4,1.5,0.6,2.1c1.4,2.7,2.8,5.3,4.1,8 c0.4,0.9,0.6,1.8,1,2.7c1.1,2,2.2,4,3.3,6c0.7,1.3,1.5,2.5,2,3.9c1.1,2.6,1.8,5.3,3,7.8c1.6,3.2,3.5,6.3,5.3,9.4 c1,1.7,2.1,3.5,3,5.2c1.1,2.1,2,2.5,3.7,1.4c2.7-1.7,4.6-4,5.8-7.1c0.2-0.6,0.1-0.8-0.5-1.2c-1-0.7-1.9-1.6-2.5-2.6 c-0.5-0.8-0.9-1.1-1.9-1c-0.7,0.1-1.8-0.1-2.3-0.6c-1.7-1.6-3.2-3.5-3.8-5.9c-0.5-1.7-0.8-3.5,0.4-5.1c-0.7-0.7-0.7-1.7-0.2-2.4 c0.4-0.6,1.1-0.9,1.7-1.4c0.1,0.1,0.2,0.2,0.3,0.3c-0.2,1.3,0.2,2.7-1,3.7c0.3,0.1,0.7,0.2,0.9,0.4c1.2,1.3,2.9,1.6,4.5,2 c1.8,0.4,3.1,1.4,3.7,3.3c0.4,1.2,1,2.3,2.6,2.6c0-0.6,0.2-1.1,0.1-1.6c-0.2-2.6,0.5-5.1,0.8-7.6c0.3-1.8,0.9-3.8-0.1-5.6 c-0.3-0.6-0.9-1.1-1.1-1.7c-0.5-1.3-0.8-2.6-1.8-3.6c-0.5-0.5-1-1.2-1.3-1.9c-0.6-1.6-1.3-3.1-2.7-4.2c-0.2-0.1-0.4-0.4-0.4-0.6 c0.2-1.3-0.9-1.9-1.5-2.8c-0.5-0.7-1.2-1.4-1.5-2.2c-0.4-1.2-1.3-1.6-2.3-1.5c-3.3,0.2-6.7,0.1-10,0.7 C567.5,75,564.9,75.3,562.2,75.2z M575.7,94.5c0.5,0.9,1,1.8,1.5,2.7c0.1,0.1-0.4,0.7-0.6,0.7c-1-0.1-1.6-0.7-1.9-1.6 C574.5,95.3,575,94.8,575.7,94.5z M574,101.7c0.9,0,1.8,0.2,2.8,0.3c0.2,1-0.4,1.4-1.2,1.4c-0.6,0-1.3-0.1-1.9-0.3 c-0.2-0.1-0.4-0.5-0.4-0.7C573.4,102,573.8,101.7,574,101.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M500.3,74c0.5,1.7,1.1,3.4,1.2,5.2c0.2,3.2,0,6.4-0.1,9.7c-0.1,4.5-1,8.8-2.4,13c-0.4,1.1-1.3,2-2,2.9 c-0.3,0.4-0.6,0.9-0.9,1.3c0.5,0.3,0.9,0.8,1.4,0.9c0.6,0.1,1.4,0,1.8-0.4c0.9-1,1.9-2.1,2.5-3.4c1-2.3,1.8-4.7,2.4-7.1 c0.9-3.5,1.5-7,2.1-10.6c0.4-2.7,1.6-5.5-0.4-8.1c-0.7-0.9-1.1-2-1.9-2.7c-1.8-1.6-3.8-3-5.7-4.4c-0.6-0.4-1.4-0.4-2.1-0.6 c-0.1,0.2-0.1,0.4-0.2,0.6c1.2,0.9,2.3,1.8,3.5,2.7C499.8,73.4,500.2,73.7,500.3,74z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M507.7,75.4c0.6,0.6,0.9,1.6,2.1,1.4c1.3-0.2,2.7-0.2,4-0.6c2.8-0.7,5.7-1.3,8.6-1.2 c1.9,0.1,3.9-0.2,5.8-0.3c-0.9-2.4-1.7-4.7-2.6-7.2c-7.3,1.1-14.8,2.1-22.5,3.3C504.8,72.5,506.3,73.9,507.7,75.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M508.9,111c0-1.4,0.1-2.8,0-4.1c0-0.8,0-1.8-0.4-2.5c-0.6-1.2-3.9-1.1-4.8,0c-0.8,1-1.6,2.1-2.4,3 c-1.7,1.9-4.5,2.5-6.5,0.6c-0.8-0.8-1.2-2-1.9-2.8c-0.4-0.4-1.3-0.8-1.7-0.6c-0.7,0.3-0.3,0.9,0.2,1.5c0.2,0.3,0.3,0.9,0.2,1.3 c0,0.2-0.5,0.3-0.8,0.4c0.1,0.3,0.2,0.5,0.2,0.8c-0.1,2.2-0.1,4.4-0.2,6.5c-0.1,1.8-0.2,3.7-0.2,5.5c0,0.3,0.3,0.9,0.5,1 c1.4,0.4,2.8,0.5,4.2,0.9c1.1,0.3,2.2,0.9,3.4,1.2c1.4,0.4,2.8,0.7,4.2,0.9c0.4,0.1,1-0.1,1.4-0.3c0.6-0.3,1-1.1,1.5-1.2 c0.9-0.2,2.1-0.4,2.8,0.1c0.8,0.6,0.1,1.6-0.4,2.3c0,0.1,0,0.2-0.1,0.4c0.5,0.1,0.9,0.2,1.4,0.3c0-1.1,0-2,0-2.9 c0-0.9,0.1-1.8,0.1-2.8c0-0.9,0.1-1.9-0.2-2.8c-0.4-1.2-0.8-2.4-0.6-3.7C508.9,113.1,508.9,112,508.9,111z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M501.6,66.3c0.2,0.1,0.4,0.1,0.6,0.1c2.5,0.1,5.5-0.8,6.4-4c0.3-1.3,0.2-2.7,0.3-4c-0.2,0-0.3-0.1-0.5-0.1 c-2.3,1.3-4.6,2.7-6.9,4C500.5,62.8,500.7,65.8,501.6,66.3z M502.8,63.8c1.3-0.8,2.5-1.5,3.8-2.2c0,0.1,0,0.2-0.1,0.3 c-0.6,2.1-2.7,2.5-3.7,2.5C502.8,64.2,502.8,64,502.8,63.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M415.1,164.6c-2.6,0.5-4.7-0.8-6.9-1.5c-2.6-0.9-5.2-1.9-7.9-2.8c-0.4-0.1-0.8,0-1.3,0 c0,0.4,0,0.9,0.2,1.3c0.2,0.5,0.5,0.9,0.7,1.3c0.1,0.3,0.2,0.6,0.1,0.9c0,0.1-0.4,0.2-0.7,0.2c-0.2,0-0.4-0.1-0.9-0.2 c0.1,0.6,0,1.2,0.2,1.3c0.9,0.8,1.8,1.7,2.8,2.2c2.7,1.2,5.5,2.3,8.3,3.3c1.9,0.7,4,1.1,6,1.7c0.9,0.3,1.7,0.6,2.8,1.1 c-0.3-2.4-0.4-4.6-0.8-6.8C417.5,164.8,416.8,164.2,415.1,164.6z M413.9,169.7c-1.2-0.3-2.4-0.6-3.5-1c-3.1-1.1-5.8-2.1-8.2-3.2 c-0.2-0.1-0.4-0.2-0.6-0.4l14.5,4.6c0,0.2,0.1,0.5,0.1,0.7C415.5,170.1,414.7,169.9,413.9,169.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M519,93.6c-1.3-0.8-2.5-1.6-3.9-2.3c-0.9-0.4-1.9-0.6-2.8-0.7c-0.6,0-1.5,0.4-1.7,0.9 c-0.5,0.9-0.5,1.9,0.3,2.8C512.7,96.2,517.4,95.8,519,93.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M531.3,86.2c0.6-0.1,1.1-0.3,1.7-0.4c-0.2-0.4-0.4-0.9-0.6-1.3c-0.5,0.3-1,0.7-1.4,1 C531.1,85.8,531.2,86,531.3,86.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M567.3,113.8c-0.2,0.1-0.4,0.3-0.6,0.4c-0.3,1.9-0.9,3.8-0.4,5.7c0.9-0.1,1.6-0.3,2.4-0.3 c0.8-0.1,1-0.4,0.8-1.1c-0.4-1.1-0.8-2.1-1.3-3.1C567.9,114.8,567.6,114.3,567.3,113.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M528,84.7c-2,0-3.6,1.1-5.4,2c0.7,0.5,1.2,1,1.7,1.4c1.7,1.3,3.4,1.2,4.9-0.2c0.9-0.8,0.5-1.8,0.2-2.6 C529.3,85,528.5,84.7,528,84.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M534.6,118.8c-1.3,0.1-2.6,0.2-3.7,0.6c-2.8,1-5.5,2.1-8.3,3.2c-0.3,0.1-0.7,0.3-0.8,0.5 c-0.5,0.9-0.9,1.5-2,0.7c-0.2-0.1-0.7,0.1-1,0.3c-2.1,1.5-4.4,2.6-6.7,3.7c-1.7,0.8-3.2,0.7-4.9,0.5c-1.5-0.1-2.9-0.5-4.4-0.5 c-1.5,0-2.8-0.5-4-1.3c-0.8-0.5-1.7-0.8-2.6-1.1c-1.3-0.4-2.7-0.8-4-1.1c-0.8-0.2-1.7-0.2-2.5-0.1c-0.3,0-0.8,0.7-0.7,1.1 c0.1,0.6,0.4,1.4,0.8,1.6c1.1,0.7,2.3,1.2,3.4,1.6c1.7,0.6,3.4,1.4,5.4,1.4c1.5,0,3,0.4,4.4,0.7c2,0.5,3.9,1.1,5.9,1.5 c1,0.2,2.1,0,3.2,0c0.2,0,0.3-0.2,0.5-0.3c2.3-1.2,4.5-2.5,6.9-3.5c2.6-1,4.9-2.4,7.3-3.8c1-0.6,2.1-1,3.2-1.4 c1.9-0.7,3.9-1.2,5.8-1.8c1.7-0.5,1.9-1.5,0.5-2.9c-0.2,0.5-0.3,1-0.5,1.4C535.5,119.4,535,118.8,534.6,118.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M562.4,119.5c0.3,0.5,0.6,1.1,0.8,1.6c0.2,0,0.3,0,0.5,0c-0.3,0.6-0.6,1.1-0.7,1.7 c-0.1,0.6-0.1,1.5,0.2,1.7c0.6,0.3,1.4,0.2,2.1,0.3c0-0.5,0.2-1,0-1.4c-2.1-4.7-0.8-9.2,0.4-13.8c0.1-0.3,0.6-0.8,1-0.8 c0.3,0,0.7,0.4,1,0.8c0.5,0.7,0.9,1.6,1.5,2.1c2.6,2.2,3.3,5.1,2.4,8.2c-0.4,1.5-0.6,2.7-0.1,4.1c0.1,0.3,0.8,0.7,1.1,0.7 c1.8-0.3,3.7-0.7,5.5-1.1c1.3-0.3,1.6-0.8,0.9-2c-0.9-1.8-1.9-3.6-2.8-5.3c-1.6-2.8-3.3-5.6-4.7-8.5c-1.3-2.7-2.3-5.5-3.5-8.3 c-0.5-1-1.2-1.9-1.7-2.9c-1.1-2.3-2.2-4.6-3.3-6.8c-0.4-0.9-0.9-1.7-1.3-2.6c-1.2-2.3-2.3-4.5-3.5-6.8c0-0.1-0.2-0.1-0.6-0.3 c-0.2,2.8-0.4,5.5-0.6,8.2c0,0.4,0.1,0.7,0,1.1c-0.1,3-0.2,6-0.2,9c0,0.7-0.1,1.3-1,1.4c-0.9,0.1-1.9,0.3-2.8,0.5 c-1.2,0.2-1.4,0.6-0.7,1.6c1,1.6,2.2,3,3.1,4.6c2.1,3.5,4,7.1,6,10.7C561.6,117.9,562,118.7,562.4,119.5z M554.9,102.3 c-0.1-0.1-0.2-0.3-0.3-0.5c0.1,0,0.3,0,0.4-0.1l1.5,2.9C556,103.9,555.5,103.1,554.9,102.3z M563.9,104.1c0.3,0.2,0.7,0.3,0.9,0.6 c0.3,0.5,0.4,1,0.6,1.5c0.1,0.3,0.4,0.7,0.3,0.9c-0.2,0.3-0.6,0.5-1.2,0.9c-0.5-0.6-1.1-1-1.1-1.5 C563.4,105.7,563.8,104.9,563.9,104.1z M561.1,108.7c0.2,0.1,0.5,0.3,0.7,0.4c0.5,0.3,1.1,0.8,1.6,0.9c0.6,0.1,1.1,0.2,0.9,0.9 c-0.1,0.4-0.6,0.8-0.7,1c-1.6,0-3-1.3-2.9-2.4C560.7,109.3,561,109,561.1,108.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M554.9,96.5c0-2.3-0.2-4.7-0.2-7c0-2,0-3.9-0.1-5.9c0-2.7,0-5.4,0-8.3c-1.3-0.1-2.8-0.2-4.4-0.2 c-2.2,0-4.5,0.2-6.7,0.3c-2,0.1-4,0.2-6,0.3c-1.1,0.1-1.4,0.7-0.9,1.7c0.9,1.6,1.8,3.1,2.7,4.7c1,1.8,2.2,3.6,3,5.5 c1.5,3.5,2.7,7.2,4.1,10.8c0.3,0.8,0.7,1,1.5,0.8c1.8-0.3,3.5-0.7,5.3-0.9C554.6,98.2,554.9,98,554.9,96.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M543.8,96.3c-1.7-5-3.6-9.8-6.6-14.2c-1.7-2.5-2.7-5.2-3-8.2c-0.3-2.1,0.1-4.5-1.9-6.1 c0,0-0.1-0.2-0.1-0.2c-0.1-1.7-1.2-2.1-2.5-2.1c-0.5,1.2-1,2.3-1.4,3.4c-0.1,0.2-0.1,0.6,0,0.8c0.8,2.3,1.7,4.6,2.5,7 c0,0.1,0.1,0.1,0.1,0.2c1.5,2.1,2.7,4.3,3.3,7c0.6,2.5,1.6,4.8,2.5,7.2c0.2,0.6,1,1,1.3,1.6c0.9,1.6,1.6,3.3,2.5,4.9 c0.2,0.5,0.5,1,0.9,1.3c0.8,0.5,1.3,1.1,1.3,2.1c0,0.9,0.7,1.2,1.6,1c0.7-0.2,1.5-0.3,1.1-1.4C544.8,99.2,544.3,97.8,543.8,96.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M536.2,93.9c-0.8-1.6-1.4-3.3-1.9-5c-0.3-0.9-0.7-1-1.5-0.5c-1.4,0.8-2.9,1.5-4.3,2.3 c-0.2,0.1-0.5,0.1-0.7,0.1c-1.2,0-2.5,0.1-3.7,0c-0.6,0-1.2-0.3-1.6-0.7c-0.9-0.7-1.6-1.5-2.4-2.2c-1.1-1-0.9-2.1,0.5-2.7 c1.3-0.5,2.8-0.9,3.9-1.7c1.5-1.1,3-1.2,4.7-0.9c0.8,0.1,1.7,0.4,2-0.5c0.2-0.7,0-1.7-0.3-2.4c-0.3-0.9-1-1.6-1.4-2.5 c-0.4-0.7-0.7-1.1-1.6-1.1c-4.5,0.2-9,0.6-13.4,1.3c-1.2,0.2-2.4,0.2-3.6,0.5c-0.6,0.2-1.4,0.7-1.5,1.2c-0.5,2.5-0.9,5-1.3,7.4 c-0.1,0.9,0.2,1.1,1,1c0.9-0.1,1.9-0.1,2.8,0c0.6,0.1,1.2,0.4,1.8,0.4c1.3,0.1,2.3,0.6,3.4,1.4c1,0.7,2.1,1.2,3.2,1.5 c1.6,0.5,2.1,1.8,1.1,3.2c-1.4,1.8-2.7,3.5-5.4,3.4c-2.4-0.1-4.8,0.2-6.7-1.8c-0.7-0.8-2.7-0.4-3.1,0.7c-0.6,1.5-1,3-1.4,4.4 c0.9,0,1.8-0.2,1.9,0c0.4,0.8,1,0.6,1.6,0.8c0.7,0.2,2-0.3,2.1,1.1c0.3,2.5,0.6,5.1,0.7,7.6c0.2,4.3,0.3,8.6,0.5,13 c0.1,1.6,0.4,1.9,1.8,1.3c1.9-0.8,3.7-1.9,5.5-2.8c0.2-0.1,0.4-0.4,0.3-0.6c-0.2-1.7-0.5-3.3-0.8-5c-0.3-1.6-0.9-3.3,0.2-4.7 c1.1-1.4,1.8-2.9,1.7-4.7c0-0.4,0-0.8,0.1-1.2c0.2-1.3,1.3-1.9,2.3-1.1c4,3.2,5.3,7,2.8,11.8c-0.3,0.5-0.4,1.2-0.4,1.8 c0,0.8,0.4,1.2,1.2,0.8c2.6-1.3,5.3-2.2,8.1-2.8c0.3-0.1,0.6-0.8,0.7-1.2c0.5-2.6-1.1-5.1-0.1-7.7c0-0.1,0-0.2,0-0.2 c-0.7-1.1-0.1-2.3-0.3-3.4c-0.2-1.8,1.4-3.6,3.4-3.8c0.5,0,0.9-0.2,1.4-0.4c-0.1-0.4-0.2-0.5-0.3-0.7 C538.2,97.3,537.1,95.7,536.2,93.9z M517.9,85.9c-1.2-0.3-2-0.4-2.9-0.7c-0.3-0.1-0.5-0.6-0.8-0.9c0.4-0.1,0.7-0.4,1.1-0.4 c0.9,0,1.8,0,2.7,0.2c0.3,0.1,0.6,0.5,0.9,0.8C518.5,85.3,518.1,85.7,517.9,85.9z M518.4,80c-0.1-0.3,0.1-0.7,0.1-1 c0.3,0.1,0.8,0,1,0.2c0.6,0.7,1.2,1.2,2.2,1.3c0.2,0,0.5,0.7,0.5,1.1c0,0.3-0.4,0.5-0.5,0.6C520.3,82.2,518.8,81.1,518.4,80z  M521,98.8c-0.2-0.3-0.4-1.1-0.3-1.2c0.4-0.3,1.1-0.7,1.5-0.6c0.8,0.3,1.5,0.9,2.3,1.5C523.1,100.3,522.2,100.3,521,98.8z  M527.4,96.1c-0.7,0.4-1.4,0.7-2.1,1.1c0-0.1-0.1-0.1-0.1-0.2c-0.4-0.1-0.8,0-1.1-0.2c-0.3-0.2-0.6-0.6-0.8-1 c0.4-0.3,0.7-0.8,1.1-0.8c0.9-0.2,1.9-0.2,2.8-0.2c0.2,0,0.6,0.2,0.6,0.4C527.7,95.4,527.6,95.9,527.4,96.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M509.9,163c-1.7-0.5-3.5-1.1-5.3-1.5c-2.6-0.7-5.2-1.4-7.9-2c-1.3-0.3-2.6-0.5-4.1-0.7 c0,2.3,0.4,2.9,2,3.3c2,0.5,4,0.7,5.9,1.3c3.2,0.9,6.3,2,9.4,3c0.2,0.1,0.4,0,0.7,0c-0.1-1-0.2-1.9-0.3-2.7 C510.3,163.3,510.1,163.1,509.9,163z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M524.8,143.4c-0.8-1.1-1.8-2.1-2.7-3.1c-0.4,0.3-0.5,0.4-0.5,0.5c-0.1,0.1-0.1,0.3-0.2,0.4 c-0.8,1.5-0.1,2.9,0.2,4.4c0.3,1.6,0.3,1.6,1.8,1.3C525,146.4,525.8,144.9,524.8,143.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M502.6,135.8c-0.2-0.8-0.7-1-1.4-0.9c-0.8,0.1-1.9,0-2.1,1.1c-0.4,2.2,0,4.4,1,6.6 C502.2,140.7,503.2,138.6,502.6,135.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M537.3,152.4c0,0.3,0.4,0.5,0.8,0.9c0.5-0.3,0.8-0.5,1-0.7c-0.4-0.3-0.7-0.7-1.1-0.9 C537.9,151.6,537.3,152.1,537.3,152.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M534.9,154.9c0-0.3-0.1-0.7-0.2-1.3c-3.2,1.8-6.1,3.6-9.2,5.3c-1.6,0.9-3.2,1.8-4.9,2.4 c-1.8,0.7-3.8,1.1-5.7,1.8c-2,0.7-2,0.9-1,2.8c0.2,0.4,0.3,0.8,0.5,1.2c1.6,0,3.1,0.2,4.5,0c3.1-0.5,6.1-1.3,9.1-1.9 c1.9-0.4,3.8-0.7,5.8-1c0.7-0.1,1.2-0.2,1.2-1.2C534.9,160.2,534.9,157.5,534.9,154.9z M518.6,165c-0.7,0.1-1.7,0.1-2.6,0.1 c-0.1,0-0.1,0-0.2,0c0,0,0-0.1,0-0.1c0,0,0,0,0,0c0.3-0.1,0.5-0.2,0.8-0.3l6.1-0.5C521.3,164.5,519.9,164.8,518.6,165z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M524.9,150.4c-0.4,0.4-0.9,0.7-1.3,1.1c0,0,0,0.2-0.1,0.7c0.7-0.5,1.2-0.8,1.7-1.2 C525.2,150.9,525,150.6,524.9,150.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M527.8,151.9c-2.6,2.1-5.4,3.5-8.6,4.3c-2.3,0.6-4.5,1.4-6.8,1.6c-1.8,0.2-3.6,0.8-5.4,0 c-1.7-0.7-3.5-1.3-5.4-1.8c-2.2-0.6-4.5-1-6.7-1.7c-1.2-0.4-1.9,0.7-2.9,0.8c0.1,0.5,0,1,0.3,1.3c0.2,0.3,0.8,0.3,1.2,0.4 c0.9,0.2,1.7,0.3,2.6,0.4c2.3,0.5,4.6,1.2,7.1,0.9c0.8-0.1,1.7,0.3,2.5,0.7c1.9,0.9,3.7,2,5.9,1.4c0.4-0.1,0.9,0,1.4,0 c0.6,0,1.3,0.3,1.8,0.2c2.2-0.7,4.6-1.2,6.7-2.3c4.5-2.2,8.9-4.7,13.3-7.2c0.7-0.4,1.4-0.9,1.8-1.5c0.6-0.9,1-2,1.6-3.1 c-0.1,0-0.2-0.1-0.3-0.1c0-0.4,0-0.8-0.2-1.2c-0.1-0.3-0.3-0.6-0.5-0.9c-0.3,0.2-0.6,0.4-0.9,0.7c-0.2,0.2-0.3,0.6-0.5,0.8 C533.1,147.9,530.4,149.8,527.8,151.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M521,133.3c-0.4,0-0.9-0.6-1.2-1c-0.3-0.5-0.4-1.2-0.5-2c-1.1,0.6-2.1,1-3.1,1.5c-1.2,0.7-2.5,1.3-3.6,2.1 c-0.3,0.2-0.6,0.8-0.6,1.3c-0.1,3.5-0.2,6.9-0.2,10.4c0,0.5,0.1,1,0.3,1.4c1.1,1.9,0.7,3.9,0.5,6c-0.1,1.1,0.5,2,1.6,2.1 c2.5,0.1,4.8-0.7,7.1-1.6c0.2-0.1,0.4-0.3,0.4-0.4c-0.2-1.5-0.2-3.1-0.9-4.3c-0.8-1.5-1.6-2.8-1.5-4.5c0.1-0.8-0.2-1.6-0.1-2.4 c0.1-2.3,0.2-4.5,1.8-6.4c0.9-1.1,1.5-1.1,2,0.3c0.7,1.8,1.8,3.2,3.2,4.5c1.6,1.6,2.1,3.2,1.4,5.4c-0.2,0.8,0,1.8,0.1,2.7 c0.1,0.8,0.7,0.9,1.3,0.4c1.9-1.5,3.8-3.1,5.6-4.7c0.2-0.2,0.3-0.7,0.3-1.1c0-1.8-0.1-3.5-0.2-5.3c-0.1-1.3-0.2-2.7-0.2-4 c0.1-2.2,0.3-4.3,0.4-6.5c0.1-1,0-2,0-3.2c-1.1,0.5-2.1,1.1-3.2,1.5c-2.5,1-5.1,1.8-7.6,2.8c-1.7,0.7-3.1,1.6-2.2,3.9 C521.9,132.5,521.8,133.4,521,133.3z M517.8,138.8c-0.3,0.3-0.7,0.4-1.1,0.6c-0.8-0.4-1.6-0.7-2.3-1.1c-0.2-0.1-0.3-0.5-0.3-0.7 c0.1-0.2,0.5-0.4,0.6-0.4c1,0.2,1.9,0.5,2.8,0.9C517.8,138.2,517.9,138.8,517.8,138.8z M524.5,133c0.4-0.7,0.9-1.3,1.5-1.9 c0.2-0.3,0.7-0.5,1-0.4c0.2,0.1,0.3,0.6,0.6,1.2c-0.6,0.8-1.1,1.8-1.8,2.5c-0.2,0.2-1-0.1-1.5-0.2 C524.3,133.8,524.3,133.3,524.5,133z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M585.7,158c-0.7-0.5-1.6-0.5-2.4-0.7c-0.2,0-0.5,0.2-0.6,0.5c-0.2,0.5-0.4,1.1-0.4,1.6 c0.2,2.1,0.6,4.2,0.9,6.2c0,0.1,0.2,0.3,0.4,0.7c1.4-1.8,2.8-3.3,2.8-5.7C586.4,159.6,586.5,158.6,585.7,158z M584.4,159.6 C584.4,159.6,584.4,159.6,584.4,159.6c0.1,0.1,0.1,0.3,0.1,0.5C584.4,159.9,584.4,159.7,584.4,159.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M603.6,127.4c-0.5-0.6-1.3-1-1.9-1.5c-0.3-0.2-0.7-0.5-1.1-0.7c-0.2,0.5-0.6,0.9-0.6,1.4 c-0.1,1.6-0.1,3.3,0,5c0.1,0.8,0.3,1.6,0.8,2.2c0.7,1.1,1.8,1.1,2.4-0.2c0.6-1.3,1-2.7,1.6-4.2C604.4,128.7,604.1,128,603.6,127.4 z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M607.4,139c-0.8,0.3-1.5,0.9-2.3,1.2c-3.9,1.4-7.5,3.7-11.6,4.6c-2.2,0.5-4.2,1.7-6.3,2.5 c-1,0.4-2.1,0.6-3.1,0.8c-2,0.2-4,0.1-5.9,0.5c-3,0.6-6,1.5-9,0.9c-0.8-0.1-1.5-0.3-2.2-0.7c-1.2-0.6-2.4-1.3-3.6-2 c-0.4-0.3-0.8-0.7-1-1.2c-0.5-0.9-0.9-1.9-1.3-2.9c-1.3,1.3-1.4,2.7-0.2,3.9c1.4,1.4,2.9,2.7,4.1,4.2c1,1.2,2.1,1.4,3.4,1.6 c0.9,0.1,1.8,0.1,2.7,0.3c1.7,0.3,3.3,0.3,4.8-0.7c0.3-0.2,0.7-0.3,1-0.3c2.2-0.3,4.4-0.4,6.6-0.7c3.3-0.5,6.6-1,9.8-1.8 c1.9-0.5,3.7-1.5,5.6-2.2c2.7-1,5.5-1.9,8.2-2.9c1.5-0.5,1.9-1.1,2-2.7c0-0.3,0-0.6,0.1-0.9C609.5,139.2,608.7,138.5,607.4,139z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M627.3,154.4c0.8-2.4,0.5-4.8,0.1-7.2c-0.1-0.6-0.8-1.1-1.2-1.7c-0.4-0.5-0.9-1-1-1.6 c-0.2-1.5-0.2-3.1-0.3-4.7c0-2.1,0-2.1,2-2.5c1.3-0.3,2.5-0.5,3.8-0.8c0-0.1,0.1-0.2,0.1-0.3c-1.5-0.1-1.9-1.3-2.2-2.4 c-0.1-0.3-0.3-0.6-0.5-0.8c-0.7-0.9-0.6-1.1,0.4-1.6c0.4-0.2,0.7-0.5,1.1-0.7c-0.1-0.1-0.1-0.3-0.2-0.4c-1.1,0.2-2.4-0.7-3.3,0.5 c-0.5,0.6-0.9,0.8-1.6,0.7c-0.5-0.1-1-0.3-1.5-0.2c-0.3,0.1-0.8,0.5-0.8,0.8c-0.1,1.5,0,2.9-0.1,4.4c0,0.6-0.1,1.2-0.2,1.9 c-0.1,0.7-0.2,1.4-0.1,2.1c0.1,1.4,0.4,2.8,0.5,4.2c0.1,1.3-0.3,2.6,0.4,3.8c0.1,0.1,0.1,0.3,0.1,0.5c0,1.8,0,3.6,0.1,5.3 c0,0.6,0.4,1.4,0.8,1.6c0.7,0.3,1.6,0.4,2.4,0.3C626.5,155.4,627.2,154.9,627.3,154.4z M624.2,134.2c0-0.5,0-0.9,0-1.4 c0,0,0.1,0,0.1,0c0.7,0.1,1.2,0,1.8-0.1c0.2,0.4,0.4,0.7,0.6,0.9c0.1,0.1,0.1,0.2,0.1,0.2c0.1,0.2,0.2,0.5,0.3,0.8 c-0.2,0-0.3,0.1-0.5,0.1c-1.1,0.2-1.9,0.5-2.4,0.9C624.2,135.2,624.2,134.7,624.2,134.2z M625.5,153.5c-0.2,0-0.5,0-0.7,0 c-0.1-1.2-0.1-2.3-0.1-3.5c0-0.6,0-1.1,0-1.7c0-0.4-0.1-1-0.4-1.5c-0.1-0.1-0.1-0.3-0.1-0.4c0,0,0,0,0,0c0.1,0.1,0.2,0.2,0.2,0.3 c0.2,0.3,0.4,0.5,0.6,0.8c0.1,0.1,0.2,0.2,0.3,0.3C625.8,149.5,626.1,151.6,625.5,153.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M599.3,163.6c0.9,0.9,1.6,2,2.4,2.7c3.7,3.3,8.3,4.6,13,5.3c2.3,0.4,5-0.2,7.2-1c3.6-1.2,5.7-4.3,7-7.8 c0.5-1.5,0.8-3.2,1-4.8c0.1-1,0-2.1,0-3.1c-0.1,0-0.2-0.1-0.4-0.1c-0.3,1-1,2-1,3c-0.1,2.5-0.8,4.8-1.9,7 c-0.9,1.8-2.1,3.5-4.4,3.9c-0.7,0.1-1.4,0.1-2,0.4c-2.5,1-5.1,1.3-7.6,0.7c-2.1-0.4-4.2-0.8-6-2.1c-1.1-0.9-2.2-1.8-3.3-2.7 C602.4,164.2,601.4,162.9,599.3,163.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M608.4,150.1c0-0.9,0.1-1.8,0-2.7c0-0.6-0.4-1-1-0.6c-2.1,1.4-4.6,1.7-7,2.4c-1.7,0.5-3.4,1.2-5.1,1.6 c-2,0.5-4.1,0.7-6.1,1c-1.6,0.3-1.8,0.5-2,2.2c0,0.2-0.1,0.5-0.1,0.7c-0.4,2.1,0.8,3.6,1.8,5.2c0.2,0.3,0.8,0.4,1.2,0.4 c1.7,0.2,3.4,0.3,4.6,0.3c2.6-0.5,4.7,0.5,6.8-0.5c0.2-0.1,0.6,0.1,0.9,0.2c0.3,0.1,0.6,0.2,0.9,0.2c1.3-0.2,2.5-0.4,3.8-0.6 c0.8-0.1,1.4-0.4,1.4-1.5C608.3,155.6,608.4,152.9,608.4,150.1z M600.6,158.4c-0.4,0.2-0.8,0.3-1.5,0.3c-0.4,0-0.8,0-1.2,0 c-0.2,0-0.4,0-0.7,0l3.5-0.3C600.7,158.4,600.6,158.4,600.6,158.4z M603.2,158.5L603.2,158.5c-0.2,0-0.3-0.1-0.4-0.1l-0.1,0 c-0.2-0.1-0.4-0.1-0.6-0.1l4.3-0.3c0,0,0,0,0,0.1C605.5,158.1,604.4,158.3,603.2,158.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M602.4,138.8c0.2,0.2,0.6,0.2,0.8,0.2c0.2,0,0.3-0.4,0.3-0.6c0-0.5-0.2-1-0.3-1.6 C601.9,137.1,601.6,138,602.4,138.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M613.1,123.9c0.2-0.3,0.3-0.6,0.5-1c0.5-1,0.9-2.1,1.3-3.1c0.4-1,0.9-2,1.3-3c0.4-0.8,0.7-1.6,1.1-2.4 c0.6-1.3,1.2-2.7,1.8-4c0.4-0.9,0.7-1.7,1-2.6c0.3-0.7,0.5-1.4,0.8-2.2c0.6-1.4,1.2-2.8,1.9-4.1c0.3-0.6,0.6-1.1,0.9-1.7 c0.4-0.7,0.8-1.3,1.1-2c0.4-0.9,0.8-1.7,1.1-2.5c0.7-1.7,1.4-3.3,2.4-4.6c0.2-0.2,0.3-0.4,0.5-0.6c0.6-0.9,0.8-1.1,1.3-1.2 c1-0.2,1.9-0.7,2.6-1.1c0.5-0.3,0.9-0.5,1.4-0.7c0.9-0.3,1.9-0.1,3,0.1c0.3,0.1,0.5,0.1,0.8,0.2c0.8,0.2,1.7,0.3,2.6,0.3 c4.3,0,7.8-2.2,9.3-5.8c0.5-1.2,0.9-2.5,0.2-3.8c-0.4-0.7-1-1.1-1.6-1.4c-0.7,0.3-1.3,0.5-1.6,0.3c-0.6-0.3-0.9-0.6-0.8-0.9 c-0.2,0-0.5-0.1-0.7-0.1c-1.4-0.3-2.8-0.5-4.3-0.7c-0.6-0.1-1.2-0.1-1.8-0.1c-1.8,0-3.2,0.5-4.4,1.5c-0.1,0-0.1,0-0.2,0l1-2.8 l0.3-0.3c0.5-0.6,1.1-1.1,1.6-1.7c0.3-0.3,1.3-1.3,1-2.6c-0.3-1.3-1.5-1.9-1.9-2.1c-1.2-0.6-2.5-1.1-3.7-1.7 c-1.1-0.5-2.2-1-3.3-1.5c-0.3-0.2-0.7-0.3-1.2-0.4c-0.5-0.1-1.1-0.2-1.6-0.3c-1-0.2-2-0.4-2.9-0.7c-1.9-0.6-3.8-1.4-5.7-2.1 c-1.5-0.5-2.9-1.1-4.4-1.6c-0.9-0.3-1.8-0.5-2.8-0.5l-0.1,0c-0.6,0-1.2,0.2-1.6,0.3c-0.1,0-0.3,0.1-0.4,0.1l-0.7,0 c-1.1,0-2.2,0.1-3.3,0.2c0.1-0.4,0.2-0.8,0.1-1.2c-0.2-1.3-1.5-2.4-2.6-2.6c-0.2,0-0.4-0.1-0.5-0.1c-0.6,0-1.1,0.2-1.6,0.5 c-0.4-0.8-1.2-2.1-2.7-2.1c-1.2,0-2.5,0.7-3.3,1.7c-0.3,0.4-0.5,0.9-0.5,1.4c-0.2,0-0.4-0.1-0.5-0.1c-0.5,0-0.9,0.1-1.3,0.3 c-1,0.4-2,1.4-1.7,3.4c0,0,0,0,0,0c-0.6-0.1-1.1-0.2-1.6-0.2c-3,0-4.3,2-5.1,3.6c-0.2,0.4-0.3,0.8-0.5,1.2c-0.4,1.1-0.6,1.3-1,1.5 c-1,0.3-1.8,1.2-2.1,2.2c0,0.1-0.1,0.2-0.1,0.2c-1.9-0.6-3.7-1.1-5.4-1.7c-2.8-1-5.7-2-8.3-3.4c-1.5-0.8-3.6-1.7-6.3-1.4 c-0.5,0.1-1.1,0.1-1.9,0.1c-0.4,0-0.8,0-1.3,0c-0.9,0-1.9,0-2.8,0c-1.6,0.1-3.3,0.2-4.9,0.3c-1.9,0.1-3.8,0.3-5.7,0.4 c-1.3,0.1-2.6,0.1-4,0.1c2-1,3.5-3.1,4-6c0.3-1.7,0.4-3.4,0.2-5c0.3-0.1,0.6-0.2,0.9-0.4c1.1-0.9,2.1-1.8,3.1-2.8 c0.6-0.7,0.8-1.4,0.9-2.1c0-0.2,0.1-0.3,0.1-0.5c0.2-0.6,0.1-1.2-0.2-1.7c-0.3-0.5-0.8-0.8-1.4-0.9c-0.1,0-0.1,0-0.2,0 c-0.3-0.1-0.4-0.1-0.6-0.1c-0.3,0-0.6,0.1-0.8,0.2c0,0,0,0,0,0l0.6-0.8c0.4-0.5,0.4-1.2,0.2-1.8l-0.2-0.5c-0.3-0.7-1-1.2-1.7-1.3 c-0.1,0-0.2,0-0.2,0c-0.3,0-0.5-0.1-0.8-0.1c-1.1,0-1.7,0.7-1.9,0.9c-0.9,1.2-1.6,2.6-2.2,3.7c0,0.1-0.1,0.1-0.1,0.2 c-0.5-0.7-1.3-1.4-2.4-1.4c-0.1,0-0.3,0-0.4,0c-1.1,0.2-2.1,1.1-2.5,2.1c-0.3,0.7-0.2,1.4-0.2,1.9c0,0,0,0,0,0c0,0.1,0,0.2,0,0.3 l0,0.3c0,0.3,0,0.7,0,1.1c0.1,0.6,0.3,1.1,0.5,1.5c-0.9,0.9-1.7,1.8-2.6,2.7c-2,1.9-2.8,4.1-2.3,6.6c0.1,0.7-0.2,1.4-0.8,1.6 l-0.2,0.1c-1.4,0.5-3.4,1.2-4.5,3.2c-1.5,0.3-2.9,0.6-4.4,0.7c-2.2,0.3-4.4,0.5-6.6,0.7l-1,0.1c0.8-1.3,1.3-2.9,1.5-4.5 c0.1,0,0.3,0,0.4,0c0.4,0,0.7-0.1,1.1-0.2l0.7-0.3c1.6-0.7,3.4-1.5,4.9-3.2c0.4-0.4,0.5-1,0.5-1.6s-0.4-1.1-0.9-1.4 c-0.1-0.1-0.2-0.2-0.3-0.2c-0.3-0.2-0.7-0.5-1.2-0.7c-0.3-0.1-0.6-0.1-0.9-0.1c-1.2,0-3.4,0.9-4.9,2c-0.1-0.1-0.1-0.3-0.2-0.4 c2.2-1.7,2.7-4.1,2.9-5.8c0.1-0.6-0.1-1.2-0.6-1.6s-1-0.6-1.6-0.6c-1.3,0.1-2.9,1.1-4.1,2.3c-0.3-0.9-0.9-1.8-2-2 c-1-0.1-2.6,0.3-3.3,1.5c-0.4,0.9-0.8,1.7-1.1,2.6c-0.1,0.3-0.3,0.7-0.4,1.1c-0.3,0.7-0.1,1.4,0.3,2c0.1,0.1,0.2,0.2,0.2,0.3 c0.2,0.3,0.5,0.8,1,1.2c-0.8,0.6-1.7,1.2-2.7,1.7c-0.5,0.3-0.9,0.6-1.4,0.8c-1.4,0.9-3.2,2.4-3.5,4.2c-0.2,1.2-0.6,1.7-1.9,2.2 c-0.1,0.1-0.3,0.1-0.4,0.1c-0.8,0.3-2.1,0.7-2.9,2c-0.1,0-0.2,0.1-0.3,0.1c-1.1,0.6-2.5,0.7-4,0.8l-0.6,0 c-1.4,0.1-2.9,0.1-4.4,0.1c-0.8,0-1.5,0-2.3,0c-0.8,0-1.5,0-2.3,0.1l-1.6,0.1c-2.2,0.1-4.4,0.3-6.6,0.4c-0.2,0-0.4,0-0.5,0 c-1.1,0-3.2,0.1-4.2,2.1c-0.6,1.1-0.9,2.4-0.9,4c0,1.1,0,2.1,0.1,3.1c-1.3-0.3-2.6-0.5-3.9-0.7l-1.6-0.3c-0.4-0.1-0.8-0.1-1.2-0.2 c-0.5-0.1-1-0.1-1.3-0.2c-3-1.1-5.7-2.2-8.2-3.3c-0.7-0.3-1.4-0.8-2-1.3c0,0,0,0,0,0c3-1,4.9-3.4,5.7-7c0-0.1,0-0.2,0.1-0.4 c0.1,0,0.3,0.1,0.4,0.1c0.1,0,0.3,0,0.4,0c1.3,0,2.5-0.7,3.1-1.4c0.7-0.7,1-1.5,0.9-2.4c-0.1-0.9-0.6-1.5-0.9-1.9 c-0.1-0.2-0.3-0.3-0.5-0.4c0.2-0.1,0.3-0.3,0.4-0.4c0,0,0,0,0,0c0,0,0,0,0,0c0.2-0.1,0.4-0.3,0.7-0.6c0.5-0.6,1-1.2,1.5-2l0.7-0.9 c0.4-0.5,0.5-1.2,0.3-1.8s-0.7-1.1-1.3-1.3c-0.2-0.1-0.3-0.1-0.5-0.2c-0.4-0.2-0.8-0.3-1.4-0.3c-0.5,0-0.9,0.1-1.3,0.4 c-1.1,0.7-2.2,1.5-3.1,2.6c-0.4,0.5-0.8,1.4-0.9,2.4c-0.4-0.3-0.8-0.5-1.3-0.6c0.1-0.4,0.1-0.8-0.1-1.1c0-0.1-0.1-0.2-0.1-0.2 c0-0.7-0.2-1.3-0.6-1.8c-0.5-0.7-1.3-1.2-2.2-1.3c-1.3-0.2-3,1-3.4,2.3c-0.4,1.1-0.4,2.3-0.4,3.3c0,0.2,0,0.5,0.1,0.7 c-1.3,0.8-2.5,1.8-3.5,2.8c-1.3,1.4-2,3-2,4.7c0,0.2-0.4,0.8-0.6,1.1l-0.3,0.4c-0.2,0.4-0.5,0.7-0.8,0.9c-0.2,0.2-0.6,0.3-1.1,0.4 l0,0c-0.4,0-0.7-0.1-1.1,0c-0.6,0.1-1.2,0.2-1.8,0.3c-1.5,0.3-2.8,0.5-4,0.2c-1.7-0.4-3.4,0.5-4.3,2.2c-1.2,0.1-2.4,0.3-3.6,0.4 c-0.9,0.1-1.8,0.2-2.8,0.3c-0.4,0-0.8,0.2-1.1,0.3c-0.1,0-0.2,0.1-0.4,0.1c-0.3,0.1-0.6,0.1-0.9,0.2c-0.7,0.2-1.3,0.3-1.8,0.4 c-2.2,0.2-4.3,0.4-6.5,0.5c-1.1,0.1-2.3,0.2-3.4,0.3c-0.6,0-1.2,0.1-1.8,0.2c-1.1,0.1-2.1,0.2-3.1,0.2c-2.2,0-3.9,1.3-4.3,3.3 c-0.3,1.5-0.3,3-0.2,4.3c0.1,1.1,0.2,2.2,0.3,3.3c-0.1,0-0.3-0.1-0.4-0.1c-0.7-0.2-1.5-0.5-2.2-0.8c-0.7-0.2-1.4-0.5-2-0.7 c-1.1-0.4-2.3-0.7-3.4-1.1l-2.2-0.7c-2.2-0.7-4.3-1.3-6.5-2c-0.5-0.2-1-0.2-1.5-0.3c-0.3,0-0.6-0.1-0.8-0.1 c-2.3-0.7-4.6-1.4-6.8-2.1c-0.2-0.1-0.4-0.1-0.6-0.2c0.6-1.3,1-2.8,0.7-4.5c-0.2-1-0.4-1.9-0.6-2.9c-0.3-1.3-0.5-2.5-0.7-3.8 c-0.1-0.1-0.2-0.2-0.2-0.3c0-0.2,0-0.4,0-0.6c-0.1-0.4-0.1-0.7-0.2-1.1l0-0.2c-0.1-0.7-0.4-2.9-2.6-3.2c-0.1,0-0.3,0-0.4,0 c-1.3,0-2.9,0.8-3.2,3.2c-0.1,0.2-0.2,0.5-0.2,0.8c-0.1,1.2-0.6,2-1.7,2.8c-1,0.7-2,1.4-2.6,2.6c-0.1,0.3-0.3,0.5-0.4,0.8 c-0.8,1.5-1.8,3.3-1.4,5.7c-0.9-0.1-1.9-0.3-2.9-0.6c-3.1-1-5.9-0.6-7.9,1.1c-0.7,0.6-1.4,0.8-2.5,1c-0.3,0-0.6,0-0.8-0.1 c-0.4,0-0.8-0.1-1.2-0.1c0,0-0.1,0-0.1,0c-1.7,0-3.5,0.1-5.2,0.2c-0.7,0-1.2,0.2-1.8,0.3c-0.2,0-0.5,0.1-0.7,0.1 c-0.7,0.1-1.3,0.2-2,0.3c-1.5,0.3-3.1,0.5-4.6,0.7c-2.5,0.3-4.2,2.1-4.2,4.4c0,1.3,0.1,2.5,0.2,3.7c0,0.6,0.1,1.2,0.1,1.8l0.1,2 c0.1,1.8,0.3,3.7,0.3,5.5c0.1,1.7,0,3.4-0.1,4.9c-0.4,4.3-0.3,8.7-0.1,12.9c0,1,0.1,2,0.1,3c0,0.4,0,0.8,0.1,1.2 c0.2,2.3,0,2.8-1,3.2c-0.7,0.3-1,0.9-1.1,1.2c-1.2,2.2-0.8,4.6,1.1,6.5l0.1,0.1c0.3,0.3,1,1,1.1,1.2c0.1,1.2,0,2.5-0.1,3.9 c-0.1,0.7-0.1,1.4-0.1,2.1c0,0.5,0,0.9,0.1,1.2c0,0.2,0,0.3,0,0.5c0.1,1.9,0.1,3.8,0.1,5.7c0,0-0.1,0.1-0.2,0.1 c-1.5,0.7-2.4,1.6-2.9,2.7c-1,2.4-0.2,4.8,2.2,6.4c0.3,0.2,0.5,0.4,0.7,0.5c0,0.3-0.1,0.6-0.2,1c-0.1,0.6-0.1,1.2-0.1,1.9 c0.1,1,0.3,2,0.4,3c0.1,0.8,0.2,1.6,0.3,2.4l0.1,0.6c0.1,0.7,0.2,1.4,0.2,2c0,1.2-0.1,2.5-0.2,3.7c-0.1,0.6-0.1,1.3-0.3,2 c0,0.3-0.1,0.6-0.1,0.9c-0.1,0.8,0.3,1.7,1.1,2l0.8,0.4c0.7,0.4,1.5,0.8,2.4,1.2c0.1,0,0.1,0.1,0.1,0.1c0,0.4,0,0.9,0.2,1.3 c-0.2,0-0.3-0.1-0.5-0.1c-0.5,0-1,0.2-1.4,0.5c-0.8,0.7-1.8,1.6-2.5,2.8c-0.5,0.8-0.5,1.9,0,2.8c0.5,0.9,1.3,1.4,2.2,1.4 c0.5,0,0.9-0.1,1.3-0.4c0,0,0,0,0,0c-0.1,0.3-0.2,0.5-0.3,0.8c-0.2,0.6-0.2,1.3,0.2,1.8l0.7,1.2c0.3,0.5,0.8,0.8,1.3,0.9 c0.1,0,0.3,0,0.4,0c0.4,0,0.8-0.1,1.2-0.4c0.1,0,0.1-0.1,0.2-0.1c0.3-0.2,0.8-0.5,1.2-1.1c0.5-0.6,1-1.4,1.2-2.3 c0.5,0.6,1.3,1,2,1c0.1,0,0.3,0,0.4,0c0.9-0.2,1.5-0.9,1.8-1.2c0,0,0.1-0.1,0.1-0.1c0.5-0.5,0.7-1.2,0.5-1.9 c-0.1-0.4-0.2-0.7-0.2-1.1c-0.2-0.7-0.3-1.4-0.5-2c0.8,0.3,1.5,0.5,2.2,0.8c0.8,0.3,1.6,0.6,2.4,0.9c1.2,0.4,2.4,0.9,3.6,1.4 l0.9,0.4c0.2,0.1,0.3,0.1,0.5,0.2c0.4,0.2,0.8,0.4,1.4,0.5c0.9,0.2,1.8,0.4,2.7,0.3c0.7-0.1,1.3-0.2,1.9-0.4 c0.6-0.2,1.1-0.3,1.6-0.3c1-0.1,1.9-0.1,3-0.1c1.8,0,3.6,0,5.4-0.4c4.2-0.8,7.5-1.1,10.5-0.9c0.2,0,0.4,0,0.5,0 c1.2,0,2.2-0.4,2.9-1.1c1-1.1,1-2.5,0.9-3.6c-0.2-2-0.2-4-0.2-6.1c0.5,0,1,0,1.5,0c0.1,0,0.5,0.1,0.7,0.2l0.2,0.1 c0.5,0.2,1.1,0.4,1.6,0.6c1.3,0.6,2.7,1.1,4.3,1.3c3.8,0.5,6.9-0.4,9.3-2.6c0.3-0.3,1.4-1.2,1.3-2.6c0-0.9-0.5-1.7-1.3-2.4 c-0.6-0.5-1.2-1-1.8-1.5c-0.8-0.7-1.6-1.4-2.5-2.1c-1.2-1-3.2-2.3-5.6-2c-1.1,0.2-2.6,0.1-4.1,0c-0.8,0-1.7-0.1-2.6-0.1 c-0.3,0-0.5,0-0.9,0l0-1.5c0-1.1,0-2.2,0-3.4c0-0.1,0-0.1,0-0.2c0.6-0.2,1.2-0.4,1.8-0.6c0.8-0.3,1.6-0.5,2.3-0.7 c0.4-0.1,0.8-0.1,1.3-0.2c0.6-0.1,1.2-0.1,1.8-0.3c0.7-0.2,1.4-0.3,2.1-0.5c-0.7,0.5-0.9,1.2-1.1,1.6c-0.2,0.6-0.3,1.9,1,3.4 l0.2,0.2c1,1.1,2.1,2.3,3.5,3.3c1.9,1.2,3.5,1.8,5.1,1.8c0.9,0,1.7-0.2,2.6-0.5c0,0.6,0,1.2,0,1.8c0,0.7,0,1.5,0,2.2 c0,2.6,2.5,5.2,5.1,5.3c0.2,0,0.4,0.1,0.6,0.1c1.1,0.4,2.1,0.8,3.2,1.2c1.9,0.7,3.9,1.5,5.9,2.2c2.5,0.9,5,1.6,7.4,2.4l1.1,0.4 c0.7,0.2,1.5,0.5,2.4,0.5c0.8,0,1.5-0.2,2.1-0.4l0.7,1c0.7,0.9,1.4,1.9,2.2,2.8c0.8,0.9,1.9,1.4,2.4,1.5c0.2,0.1,0.4,0.1,0.6,0.1 c1.5,0,2.4-1.5,2.6-2.1c0.7-1.6,1.2-3,1.6-4.4c1.4-0.2,2.9-0.4,4.3-0.6l2.2-0.3c0.4-0.1,0.7-0.1,1.1-0.1c0.4,0,0.9-0.1,1.3-0.1 c1-0.1,2.1-0.1,3.1-0.3c1-0.2,1.8-0.8,2.3-1.6c0.3-0.6,0.7-1.5,0.2-2.8c0-0.1,0-0.1,0-0.2c0.4,0.1,0.8,0.3,1.2,0.4 c0.4,0.1,0.8,0.3,1.2,0.4c0.3,0.1,0.5,0.2,0.8,0.3c0.7,0.2,1.3,0.5,2,0.7c0.7,0.2,1.5,0.4,2.2,0.6c1.3,0.3,2.5,0.6,3.7,1 c1.5,0.6,3.4,1.1,5.5,1c0.4,0,0.8-0.1,1.3-0.1c1.3-0.1,2.5-0.2,3.4-0.1c0.7,0.1,1.5,0.2,2.3,0.2c1.6,0,3.1-0.2,4.6-0.5 c1.2-0.2,2.4-0.4,3.6-0.4c1.1,0,2.2-0.2,3.2-0.3c0.9-0.1,1.8-0.2,2.7-0.2c1.9-0.1,3.2-0.7,3.8-1.9c0.7-1.2,0.6-2.6-0.3-4.2 c0-0.1-0.1-0.1-0.1-0.2l1.1-0.1c0.8-0.1,1.1-0.9,0.8-1.5l-3.4-7.4c0.3,0.4,0.7,0.7,1.2,1c0.3,0.2,0.6,0.4,0.8,1.7 c0,0.1,0,0.3,0.1,0.4c0.1,1.2,0.4,3.4,2.7,4.3c1.3,0.5,2.7,1,4.1,1.3c0.8,0.2,1.6,0.3,2.4,0.5c0.9,0.2,1.7,0.3,2.5,0.5 c1.9,0.5,3.9,1.2,6.2,2c0.4,0.1,0.8,0.4,1.2,0.6c0.4,0.2,0.8,0.5,1.3,0.7c0.2,0.1,0.4,0.2,0.5,0.3c0.6,0.4,1.5,0.9,2.7,0.9 c0.7,0,1.4-0.2,2-0.5c0,0,0.1,0,0.1,0c0.2,0,0.4,0,0.7,0c0.3,0,0.7,0.1,1,0.1c0,0,0.1,0,0.1,0l0.2,0c0.2,0,0.4,0,0.6,0 c0.3,0,0.5,0,0.8,0c0.4,0,1.1,0,1.8-0.2c1-0.2,2-0.5,3-0.7c2.8-0.7,5.4-1.3,8.1-1.6c1.3-0.1,2.4-0.3,3.5-0.5 c0.5-0.1,0.9-0.3,1.3-0.4c0.2-0.1,0.6-0.2,0.7-0.2c2-0.1,3.3-1.5,3.3-3.5c0-0.6,0-1.1-0.1-1.7c0.3-0.2,0.4-0.6,0.4-1.1l0-1.5 c0.7,0.4,1.4,0.8,2.2,0.9c1.5,0.3,3.1,0.5,4.6,0.5c0,0.1-0.1,0.2-0.1,0.2c0,0.1,0,0.1,0,0.2c-0.1,0.4-0.3,1.1-0.1,1.8 c0.3,1,0.6,2,1,2.8c0.3,0.7,0.8,1.1,1.2,1.4c0.1,0.1,0.2,0.1,0.2,0.2c0.4,0.4,0.9,0.6,1.4,0.6c0,0,0.1,0,0.1,0 c0.6,0,1.1-0.3,1.4-0.7l1.1-1.4c0.5-0.6,0.6-1.5,0.2-2.2c-0.1-0.2-0.2-0.3-0.2-0.5c0.3,0.2,0.5,0.4,0.8,0.6 c0.2,0.1,0.4,0.3,0.5,0.4c0.4,0.3,0.8,0.4,1.3,0.4c0.4,0,0.7-0.1,1.1-0.3c0.2-0.1,0.3-0.2,0.5-0.3c0.6-0.3,1.5-0.8,1.7-1.9 c0.3-1.4-0.7-2.5-1.1-3c-0.6-0.6-1.3-1.1-2-1.3c-0.4-0.1-0.8-0.2-1.3-0.2c-0.2,0-0.5,0-0.7,0.1c0-0.5-0.2-1.2-0.6-1.9c0,0,0,0,0,0 c0.3,0.1,0.5,0.1,0.8,0.1c2,0,4.7-2,4.7-4.2c0-0.5-0.1-1-0.2-1.4c0.6,0.7,1.3,1.4,2.2,1.9c0,0.1,0,0.1,0,0.2c-0.1,1.3,0,3.1,1.2,4 c1.3,1.1,2.8,1.9,4.4,2.5c1.5,0.5,3,0.9,4.4,1.3c0.9,0.2,1.8,0.5,2.6,0.7c0.6,0.2,1.2,0.4,1.8,0.6c1.1,0.4,2.2,0.8,3.4,1l0.2,0 c0.1,0,0.3,0,0.4,0.1c0,0.2,0,0.4,0.1,0.5c0.2,1.5,0.4,2.8,0.6,4.1c-0.2,0-0.4-0.1-0.6-0.1c-0.3,0-1.5,0.1-2.2,1.1 c-0.5,0.7-0.9,1.5-1.3,2.2l-0.4,0.7c-0.4,0.6-0.3,1.4,0.1,2.1c0.1,0.1,0.1,0.2,0.2,0.3c0.2,0.4,0.6,1.1,1.3,1.5 c0.3,0.1,0.7,0.2,1,0.2c0.2,0,0.3,0,0.5-0.1c0,0.8,0.5,1.5,0.8,1.8c0.6,0.7,1.3,0.8,1.8,0.8c0.1,0,0.1,0,0.2,0 c1-0.1,2.2-0.8,2.6-1.9c0.1-0.3,0.2-0.6,0.3-0.9c-0.2,0.7,0,1.4,0.1,1.9c0.3,0.9,1.1,1.5,1.9,1.8c-0.6,1.4-1,2.8-1.3,4.1 c-0.2,0.8-0.1,1.5,0,2.1c0,0.2,0,0.3,0.1,0.5c0.1,0.8,0.6,1.5,1.4,1.8l0.5,0.1c0.2,0.1,0.4,0.1,0.6,0.1c0.5,0,1-0.2,1.4-0.6 c0.1-0.1,0.2-0.2,0.3-0.3c0.5-0.4,1.2-0.9,1.5-1.8c0-0.1,0-0.1,0.1-0.2c0.5,0.4,1,0.7,1.6,0.7c0,0,0.1,0,0.2,0 c0.9,0,2.4-0.7,2.7-2.1c0.2-1.3,0.5-2.7,0.5-4.1c0-0.3,0-0.5-0.1-0.7c0.3-0.1,0.7-0.2,1-0.3c0.6-0.2,1.2-0.4,1.8-0.5 c2.2-0.6,3.2-2.3,3.8-3.6c0.3-0.7,0.8-1.4,1.4-1.8c0.2,0,0.6,0.2,0.8,0.3c0.4,0.2,0.9,0.3,1.4,0.4c1.5,0.3,3,0.8,4.6,1.4 c0.6,0.2,1.2,0.4,1.8,0.6c2,0.7,3.7,0.9,5.4,0.8c0,0.4,0,0.7,0.1,1.1c0,0.4,0,0.7,0.1,1.1c0,1.1,0.1,2.3,0.5,3.4 c0.4,1.2,1,2.3,1.6,3.4c0.1,0.2,0.2,0.3,0.3,0.5c-0.4,0.4-0.7,0.9-0.9,1.4c-0.2,0.6-0.4,1.1-0.6,1.7c-0.1,0.4-0.2,0.7-0.4,1.1 l-0.1,0.2c-1,2.6,0.2,3.8,1.3,4.4c0.5,0.2,0.9,0.4,1.4,0.4c0.5,0,1.1-0.1,1.8-0.6c0.6,0.5,1.4,0.9,2.2,0.9c0.3,0,0.6-0.1,0.9-0.2 c1.1-0.4,2.1-1.8,2.2-3c0,0,0,0,0,0c0.7,1,1.9,1,2.6,1c0.2,0,0.3,0,0.4,0c0.6,0.1,1.2-0.1,1.6-0.5s0.7-1,0.6-1.6 c0-0.1,0-0.2,0-0.3c0-0.4,0-1-0.3-1.7c-0.4-1-0.9-2.1-1.6-3.3c-0.3-0.5-0.6-1-0.9-1.4c0-0.1,0-0.1,0-0.2c0.6-3.1,0-6-1.9-8.7 c-0.4-0.6-0.8-1.3-1.2-2c0.2-0.1,0.3-0.2,0.5-0.4c0.2-0.2,0.5-0.3,0.7-0.5c1.2-0.8,2.9-1.9,3.3-4.2l0.1-0.2c1.5-2.7,3-5.4,3.3-8.7 c0.1,0,0.2-0.1,0.3-0.1c0.9-0.2,2-0.5,2.4-0.4c1.5,0.5,3.1,0.3,4.4,0.1l0.3-0.1c1.9-0.3,3.1-1.9,3-4c0-0.5-0.1-1-0.1-1.5 c-0.1-0.9-0.1-1.7-0.1-2.5c0-1.3,0-2.7,0.1-4c0-0.8,0.1-1.6,0.1-2.4c0.1-2.6,0.1-5.2,0.1-7.8l0-0.6c0-0.8,0-1.6-0.1-2.5 c-0.1-0.7-0.3-1.4-0.4-2c-0.1-0.4-0.2-0.8-0.3-1.2c-0.1-0.4-0.1-0.8-0.2-1.2c-0.1-0.7-0.2-1.4-0.4-2.2c-0.7-2.5-2.2-3.8-4.5-3.8 c-0.5,0-1,0.1-1.6,0.2c-1.5,0.3-2.7,0.5-3.9,0.5l-0.2,0c-0.3,0-0.7,0-1,0c-0.5,0-1-0.1-1.5-0.1c-1.2,0-2.9,0.1-4.5,1.4 c-0.1,0-0.2,0-0.2,0l-0.3,0c-0.5,0.1-1,0.1-1.4,0.2c-1.1,0.1-2.3,0.3-3.5,0.7c-0.1,0-0.3,0.1-0.5,0.1c-1.2,0.4-3.5,1.1-4.1,3.7 c-0.2,1.1-0.4,2.2-0.4,3.4c0,2.2,0.1,4.5,0.2,7.6l0,1c0.1,1.8,0.2,3.7,0.5,5.5c0.1,0.7,0.1,1.4,0.2,2.2c0.1,1.6,0.1,3.3,0.9,5.1 c0.2,0.3,0.3,0.8,0.4,1.2c0.2,0.6,0.3,1.2,0.6,1.8c0.4,0.9,1.1,1.9,1.8,2.9c0.7,0.9,1.9,1,2.4,1c0.3,0,0.5,0,0.7-0.1 c-0.1,0.2-0.2,0.4-0.3,0.6c-0.7,1.5-1.4,2.2-2.4,2.4c-0.6,0.1-1.2,0.3-1.7,0.5c-0.6,0.2-1.1,0.4-1.6,0.5c-0.3,0.1-0.9,0-1.5-0.1 l-0.2,0c-0.1,0-0.3-0.1-0.5-0.1c-0.5-0.2-1.2-0.4-1.9-0.3c-1.5,0.1-2.7-0.5-4.2-1.3c0.6-0.3,1.1-0.6,1.6-1.1c1-1,1.5-2.3,1.5-3.7 c0-3.7-0.1-7.8-0.2-12.4c0-0.1,0-0.2,0-0.2c0,0,0,0,0.1-0.1c0.5-0.4,1.6-1.4,1.8-2.9c0.2-1.2,0.2-2.4,0.3-3.6 c0-0.6,0.1-1.1,0.1-1.7c0.1-1.7-0.7-3.1-2.2-3.6c0.1-1.3,0.1-2.9-0.1-4.6c-0.2-1.9-0.3-3.9,0.6-5.7 C612.9,124.2,613,124.1,613.1,123.9z M512.8,58c0.4-1,3.8-2.7,4.7-2.4c0.3,0.1,0.6,0.4,1,0.7c-1.4,1.7-3.2,2.3-4.9,3 C513,59.5,512.5,58.7,512.8,58z M451.8,55.6c0.7-0.9,1.7-1.6,2.7-2.2c0.2-0.2,0.8,0.2,1.4,0.4c-0.9,1.2-1.5,2-2.2,2.9 c-0.1,0.2-0.3,0.2-0.5,0.4c-0.5,0.5-1.2,1.2-1.8,0.4C451.2,57.2,451.4,56.1,451.8,55.6z M453.1,60.6c0.1,0.2,0.5,0.4,0.5,0.8 c0.1,0.8-1.3,1.8-2.2,1.6c-0.3,0-0.7-0.4-0.7-0.7C450.6,61.4,451.7,60.6,453.1,60.6z M553.6,160.7c0.2-0.2,0.8-0.2,1.2-0.1 c0.5,0.2,0.9,0.5,1.3,0.8c0.3,0.3,0.7,0.8,0.6,1.2c-0.1,0.3-0.7,0.5-1.3,0.9c-0.7-0.6-1.4-1-1.9-1.6 C553.2,161.6,553.3,160.9,553.6,160.7z M602,57.3c0.4,0.1,0.9,0.6,1,0.9c0.1,0.8-1.6,2.6-2.4,2.4c-0.3-0.1-0.6-0.6-0.7-0.7 C600,58.6,601.2,57.2,602,57.3z M595.9,56.5c0.4-0.5,1.1-0.9,1.7-0.9c0.4,0,0.8,0.7,1,1.3c0.2,0.5,0.2,1.2,0.2,1.8c0,0,0,0-0.1,0 c0,0.3,0,0.7,0,1c0,0.6-0.1,1.3-0.9,1.3c-0.8,0-1.3-0.3-1.5-1.1c-0.1-0.6-0.5-1.1-0.6-1.7C595.7,57.7,595.6,56.9,595.9,56.5z  M546.1,45.7c0.1-0.1,0.2,0,0.6,0.1c-0.2,0.7-0.3,1.4-0.7,1.9c-0.8,1-1.8,1.8-2.8,2.6c-0.2,0.2-0.8,0.1-0.9-0.1 c-0.2-0.3-0.2-0.9,0-1.1C543.4,47.9,544.8,46.8,546.1,45.7z M540.8,44.9c0.6-1.2,1.3-2.4,2.1-3.5c0.1-0.2,0.8,0,1.2,0.1 c0.1,0.2,0.1,0.3,0.2,0.5c-0.8,1.2-1.6,2.4-2.4,3.6c-0.1,0.1-0.6,0.2-0.7,0.1C540.9,45.5,540.7,45,540.8,44.9z M535.4,47.1 C535.5,47.1,535.5,47.1,535.4,47.1c0-0.5-0.1-1.1,0.1-1.6c0.1-0.4,0.6-0.8,1-0.8c0.3,0,0.7,0.4,0.9,0.7c0.5,1.1,0.2,2.5-0.7,3.3 c-0.2,0.2-0.6,0.3-0.9,0.3c-0.2,0-0.3-0.5-0.3-0.8C535.4,47.9,535.4,47.5,535.4,47.1z M513.1,49.1c-0.2,1.9-0.7,3.5-2.3,4.6 c-0.3,0.2-0.9,0.3-1,0.2c-0.3-0.2-0.5-0.8-0.5-1.1C509.3,51.5,511.6,49.3,513.1,49.1z M505.3,49.9c0.2-0.3,0.8-0.5,1.2-0.5 c0.2,0,0.5,0.7,0.5,1.1c-0.1,1.1-0.2,2.3-0.6,3.3c-0.2,0.5-0.9,1-1.4,0.9c-0.4,0-0.7-0.8-1.1-1.3C504.4,52.1,504.8,51,505.3,49.9z  M443.6,54.6c0.1-0.4,0.9-1,1.3-0.9c1,0.1,1.2,0.9,1,1.9c0.1,0,0.2,0.1,0.3,0.1c-0.4,0.8-0.8,1.6-1.3,2.3c-0.2,0.2-0.8,0.4-1,0.3 c-0.3-0.1-0.6-0.6-0.6-0.9C443.3,56.5,443.3,55.5,443.6,54.6z M322,181.6c-0.7,0.4-1.1-0.5-0.8-1c0.6-0.9,1.4-1.6,2.2-2.3 c0.1-0.1,0.7,0.4,1.5,0.8C323.7,180.1,323,181,322,181.6z M327.3,183.5c-0.1,0.6-0.6,1.2-1,1.8c-0.2,0.3-0.6,0.5-1,0.7 c-0.2-0.4-0.5-0.8-0.7-1.2c0.4-1.1,0.8-2.1,1.2-3c0.3-0.6,0.9-0.6,1.2,0C327.3,182.3,327.4,183,327.3,183.5z M326.8,179.4 c0-0.2,0-0.4,0-0.6c0.2,0,0.5,0.1,0.8,0.1c0,0,0,0,0,0c0,0,0.1,0,0.1,0c0,0.2,0,0.3,0,0.5c0,0.1,0,0.2,0,0.3 C327.4,179.5,327.1,179.4,326.8,179.4z M331.3,183.1c-0.2,0-0.8-0.4-0.9-0.7c-0.3-1-0.6-2.1-0.7-3.2c0-0.5,0.5-1,0.7-1.6 c0.3,0.4,0.8,0.7,0.9,1.2c0.3,1.1,0.5,2.2,0.9,3.5C331.9,182.6,331.6,183,331.3,183.1z M486.8,151.2c-1,0.5-1.9,1.8-1.7,3.1 c0,0.3,0.1,0.6,0.2,1l-2.1-4.4c0.3-0.1,0.7-0.1,1.2-0.2c0.4,0,0.8-0.1,1.2-0.1c0.5-0.1,1-0.2,1.5-0.3 C487.2,151,487.1,151.1,486.8,151.2z M550,166.7c-0.3-0.3-0.8-0.6-1-1c-0.4-0.8-0.7-1.6-0.9-2.4c-0.1-0.4,0.1-0.8,0.2-1.2 c0.4,0.1,1.1,0,1.3,0.3c0.6,0.8,1,1.8,1.6,2.9C550.7,165.8,550.3,166.3,550,166.7z M553.2,154.7c-0.3-0.1-0.6-0.6-0.6-0.9 c0-0.3,0.3-0.8,0.6-0.9c0.7-0.4,1.5-0.7,2.2-1.1c0.7-0.4,1.1-0.1,1.1,0.8C556.4,153.7,554.3,155.2,553.2,154.7z M554.5,150 c-0.2,0.1-0.4,0.2-0.7,0.3c-0.6,0.3-1.1,0.5-1.7,0.9c-0.6,0.4-1.2,1.1-1.4,1.9c-0.3-0.5-0.6-0.9-0.9-1.3c-0.5-0.7-2-2.8-4.8-2.8 c-0.4,0-0.8,0-1.2,0.1c-0.1,0-0.1,0-0.2,0c-0.5,0-1.2-0.4-1.9-0.9c0,0,0,0,0,0c0-0.1,0.1-0.2,0.1-0.4c0.5-1.5,0.4-3.2-0.3-4.7 c-0.5-1.1-1.4-2-2.4-2.6l-0.4-14.9c0.6,0,1.9-0.4,2.2-2.5c0.6-0.1,1-0.1,1.4,0.2c0.5,0.3,1.3,0.6,2.2,0.7c4.1,0.3,7.5-1.5,9.8-5.1 c0.5-0.8,0.9-1.8,1.2-2.8c0.3-1,0-2.8-1.4-3.5c-1-0.5-2.2-1-3.4-1.3c-0.9-0.2-1.7-0.2-2.5-0.3c-0.8-0.1-1.6-0.1-2.4-0.3 c-2.5-0.5-4.7,0.3-6.5,2.5c-0.1,0.2-0.3,0.3-0.5,0.4c0-1.1,0-2.3,0-3.4c0-1.5,0-3,0-4.6c0-0.4,0-0.8,0-1.1c0-0.2,0-0.4,0-0.5 c0.1-0.1,0.3-0.2,0.6-0.3c0.8,1.6,2.7,2.7,4.7,2.7c1.3,0,2.5-0.5,3.3-1.4c0.4-0.5,0.8-1,1.2-1.5c0.3,0.4,0.6,0.8,0.9,1.1 c0.5,0.6,0.9,1.2,1.4,1.8c0.2,0.3,0.5,0.6,0.7,0.9c0.4,0.5,0.8,0.9,1,1.4c1.2,1.9,2.4,4,3.6,6c0.2,0.4,0.4,0.8,0.6,1.2l0.4,0.9 c0.2,0.4,0.4,0.8,0.5,1.2c-0.8,0.9-1.5,1.7-2.3,2.3c-1.8,1.4-2.6,3.3-2.3,5.6c0.1,1,0.7,1.7,1.1,2.2c0.1,0.1,0.3,0.3,0.3,0.4 c0.8,2.2,2.5,3.3,3.8,4.2c0.2,0.1,0.4,0.3,0.7,0.5c0.4,0.3,0.8,0.5,0.9,0.7c0,0.3-0.1,0.9-0.1,1.1c-0.1,0.5,0,1,0,1.4 c0,0.2,0,0.4,0,0.5c0,0.2,0,0.4,0,0.5c-0.4,0.4-0.8,0.8-1.3,1.2c-0.3,0.2-0.5,0.5-0.8,0.7c-1.7,1.6-3.2,6.1-1.6,8.5 c0.2,0.3,0.3,0.5,0.5,0.8c0.2,0.4,0.5,0.8,0.8,1.2C556.6,149.5,555.5,149.4,554.5,150z M579.4,170.9c-0.3,0.9-0.7,1.9-1.2,2.8 c-0.1,0.2-0.7,0.5-0.9,0.4c-0.3-0.2-0.4-0.6-0.7-1.1c0.5-1,1-1.9,1.6-2.8c0.1-0.2,0.6-0.2,0.7-0.1 C579.3,170.2,579.5,170.7,579.4,170.9z M581.5,176.1c-0.1,0.3-0.6,0.6-0.9,0.6c-0.2,0-0.6-0.5-0.6-0.7c0.1-1.3,0.3-2.5,0.5-3.8 c0-0.2,0.8-0.6,0.9-0.5c0.4,0.3,0.6,0.8,0.9,1.3C582.1,174.1,581.9,175.1,581.5,176.1z M584.5,174.4c-0.4,0.3-0.6,0.7-0.7,1 c0.1-0.4,0.2-0.7,0.3-1.1c0.1-0.3,0.2-0.6,0.2-1c0-0.1,0-0.2,0-0.2c0.6,0.3,1.2,0.3,1.5,0.3c-0.4,0.3-0.8,0.6-1.1,0.8L584.5,174.4 z M585.7,177.1c-0.1-0.3-0.1-0.9,0.1-1.1c0.9-0.8,1.9-1.6,3.3-1.6c0.1,1.4-1.5,3.3-2.6,3.2C586.2,177.6,585.8,177.3,585.7,177.1z  M588.4,170.1c-0.2-0.8-0.4-1.5-0.7-2.2c0.3-0.5,0.6-1,0.9-1.4c0.4-0.4,0.6-0.6,0.5-0.6c1-0.2,1.9-0.3,3-0.5 c0.6-0.1,1.2-0.2,1.8-0.3c0.2,0.4,0.5,0.7,0.8,1.1c-2.9,0.8-4.9,2.8-5.9,5.8c0,0.1-0.1,0.2-0.1,0.3c-0.4,0-0.7,0.1-1.1,0.1 c0.1-0.1,0.1-0.1,0.2-0.2C588.1,172,588.6,171.1,588.4,170.1z M588.2,184.8c-0.2,0.5-0.9,0.9-1.3,1.3c-0.2,0-0.3-0.1-0.5-0.1 c0-0.7-0.3-1.4-0.1-2c0.4-1.4,0.8-2.8,1.4-4.1c0.2-0.4,0.7-0.6,1.1-0.8c0.2,0.4,0.7,0.9,0.6,1.2 C589.1,181.8,588.7,183.4,588.2,184.8z M592.6,183.7c0,0.2-0.5,0.4-0.7,0.4c-0.2,0-0.6-0.3-0.7-0.5c-0.1-0.5-0.1-1-0.2-1.7 c0.1-0.6,0.1-1.4,0.3-2.1c0.1-0.3,0.6-0.9,0.8-0.8c0.4,0.1,1,0.5,1,0.8C593.1,181.1,592.9,182.4,592.6,183.7z M624.4,193.3 c-0.3,0.1-1.1-0.3-1.3-0.7c-0.5-1.1,0-3,1.1-4.1c0.3,0.4,0.6,0.7,0.7,1.1c0.2,0.8,0.4,1.6,0.4,2.4 C625.3,192.5,624.9,193.1,624.4,193.3z M610.3,130.3c0.2,1.5,0.1,3,0.1,4.5c0,1,0.3,1.5,1.2,1.7c0.9,0.2,1.1,0.8,1.1,1.6 c-0.1,1.7-0.1,3.5-0.3,5.2c-0.1,0.6-0.6,1.2-1,1.5c-0.6,0.5-0.9,1.1-0.8,1.9c0.1,4.1,0.2,8.2,0.2,12.4c0,1.8-1.5,3.3-3.4,3.3 c-0.7,0-1.5,0.3-2.2,0.5c0.5,0.6,1,1.4,1.6,1.7c2.3,1.1,4.4,2.8,7.2,2.6c0.6,0,1.3,0.3,2,0.4c0.8,0.1,1.6,0.2,2.4,0.1 c1.2-0.2,2.3-0.7,3.4-1c1.9-0.4,2.9-1.9,3.7-3.4c0.6-1.1,0.8-2.4,1.2-3.6c0.1-0.2,0-0.5,0-0.8c-0.3,0-0.6-0.1-0.9,0 c-0.7,0.3-1.5,0.6-2.2,0.8c-0.4,0.1-1,0-1.2-0.2c-0.6-0.7-1.2-1.5-1.6-2.4c-0.4-1-0.6-2-1-3c-1-2.2-0.6-4.5-0.9-6.7 c-0.3-2.1-0.4-4.2-0.5-6.3c-0.1-2.5-0.2-5-0.2-7.5c0-1,0.2-2,0.4-3c0.4-1.7,2-2,3.2-2.4c1.5-0.5,3.1-0.6,4.7-0.8 c0.4-0.1,0.9-0.1,1.3-0.4c1.8-1.4,3.8-1,5.9-1c1.5,0,3.1-0.2,4.6-0.5c2.1-0.4,3.2,0.1,3.8,2.2c0.3,1,0.3,2.2,0.5,3.2 c0.2,1,0.6,2,0.7,3.1c0.1,0.9,0.1,1.8,0,2.8c0,2.6-0.1,5.2-0.1,7.8c0,2.2-0.2,4.3-0.2,6.5c0,1.4,0.2,2.8,0.2,4.1 c0.1,1-0.4,1.8-1.3,1.9c-1.2,0.2-2.3,0.5-3.8,0.1c-1.5-0.5-3.3,0.4-5,0.7c-0.1,0-0.3,0.4-0.3,0.6c0,3.5-1.6,6.3-3.2,9.2 c0,0.1-0.1,0.1-0.1,0.2c-0.2,2-1.9,2.7-3.3,3.7c-0.4,0.3-0.9,0.7-1.3,1.1c-0.2,0.2-0.3,0.7-0.2,0.9c0.5,1.1,1.1,2.2,1.8,3.2 c1.5,2.2,2.1,4.5,1.6,7.1c-0.1,0.4-0.2,0.9-0.1,1.1c0.4,0.6,0.8,1.1,1.1,1.7c0.6,1,1.1,2.1,1.5,3.2c0.2,0.4,0.1,0.9,0.1,1.3 c-0.6-0.1-1.6,0-1.7-0.3c-0.7-1.7-2.7-2.8-1.8-5.1c-0.1,0-0.2-0.1-0.3-0.1c-0.4,0.5-0.9,0.9-1.3,1.4c-1.1,1.3-1.2,1.3-2.6,1.2 c-0.4,1.2-0.8,2.4-1.3,3.5c-0.3,0.8-0.9,1.6-1.8,1.1c-1-0.5-0.5-1.4-0.2-2.2c0.3-0.9,0.6-1.8,0.9-2.7c0.1-0.3,0.3-0.7,0.6-0.7 c1.1-0.4,0.9-1,0.5-1.8c-0.7-1.3-1.5-2.6-2-4c-0.4-1.3-0.3-2.7-0.4-4.1c-0.1-0.9,0-1.8-0.2-2.7c0-0.2-0.6-0.5-0.9-0.4 c-2,0.5-3.9,0.1-5.7-0.5c-2.2-0.7-4.4-1.7-6.7-2.1c-1.2-0.2-2.6-1.3-3.8-0.4c-0.8,0.7-1.6,1.6-2,2.6c-0.6,1.2-1.3,2.2-2.6,2.5 c-2.1,0.6-4.2,1.3-6.3,1.8c-0.6,0.1-1.3-0.2-1.9-0.3c0.1-0.6,0.2-1.2,0.4-1.8c0.4-1.2,1-2.3,1.4-3.5c0.8-2.5,2.4-4.1,5-4.7 c0.4-0.1,0.8-0.1,1.1-0.3c1.1-0.6,1-1.1,0.1-1.9c-0.6-0.6-1.2-1.3-1.6-2.1c-0.3-0.6-0.6-0.8-1.3-0.6c-1.8,0.3-3.7,0.5-5.4,0.8 c-0.6,0.1-1.2,0.7-1.6,1.3c-0.7,0.8-1.2,1.7-1.6,2.4c0.4,1.1,0.7,2,1,2.9c0.1,0.2-0.2,0.8-0.4,0.9c-0.4,0.1-0.9,0-1.2-0.3 c-0.3-0.3-0.5-0.8-0.7-1.3c-1.3,0.7-2.3,0.2-2.7-1.4c-0.3-1.6-0.5-3.1-0.7-4.7c-0.2-2-0.3-2-2.2-2.3c-1.7-0.3-3.3-1.1-5-1.6 c-2.3-0.7-4.7-1.2-7-1.9c-1.3-0.5-2.6-1.2-3.7-2.1c-0.5-0.4-0.5-1.6-0.5-2.4c0.1-0.9-0.1-1.6-0.9-2.1c-1.8-1-2.7-2.8-3.7-4.4 c-0.8-1.3,0.1-4.7,1.3-5.9c0.8-0.7,1.6-1.4,2.3-2.2c0.3-0.4,0.3-1,0.4-1.6c0-0.6-0.2-1.2-0.1-1.8c0.3-2.3,0.1-2.4-1.7-3.7 c-1.4-1-3-1.8-3.7-3.7c-0.3-0.8-1.2-1.4-1.3-2.1c-0.2-1.5,0.2-2.8,1.5-3.8c1.1-0.9,2.1-2,3-3.1c0.2-0.2,0.2-0.8,0.1-1.1 c-0.2-0.7-0.6-1.5-0.9-2.2c-0.3-0.6-0.5-1.3-0.9-1.9c-1.2-2-2.4-4.1-3.7-6.1c-0.5-0.8-1.2-1.6-1.8-2.4c-0.9-1.2-1.8-2.4-2.7-3.6 c-0.7-0.9-1.8-0.8-2.4,0.2c-0.4,0.6-0.8,1.3-1.3,1.9c-1.5,1.6-4.4,0.4-4.9-1.2c-0.2-0.8-0.3-1.5-1.6-1c-3.2,1.2-2.6,1.3-2.7,4 c0,2.8,0,5.5,0,8.3c0,0.4-0.1,0.9-0.2,1.3c1.6,0.7,3.3,0.5,4.3-0.7c1.2-1.5,2.6-2.3,4.6-1.8c1.6,0.3,3.3,0.3,5,0.6 c1,0.2,2,0.6,2.9,1.1c0.3,0.1,0.4,0.8,0.3,1.2c-0.2,0.8-0.5,1.5-0.9,2.2c-1.8,2.9-4.5,4.5-7.9,4.2c-0.5,0-0.9-0.2-1.3-0.4 c-1-0.6-1.9-0.6-3-0.4c-0.9,0.2-1.3,0.6-1.4,1.5c-0.1,0.9-0.3,1.3-1.2,0.6c-0.2-0.2-0.6-0.3-0.8-0.2c-0.2,0.1-0.3,0.5-0.3,0.8 c-0.1,2.5-0.3,5-0.3,7.5c0,1.8,0.1,3.6,0.1,5.4c0,1.3,0,2.7,0.1,4c0,0.3,0.4,0.8,0.8,0.9c2.1,0.7,3.4,3.2,2.6,5.2 c-0.4,1-0.6,1.9,0.7,2.8c1.2,0.8,2.3,1.5,3.6,1.2c1.8-0.4,3,0.6,4,1.9c1.1,1.5,2.1,3.1,2.9,4.7c0.8,1.4,0.2,2.2-1.3,2.1 c-2.5-0.2-5.1-0.1-7.5-0.7c-1.5-0.3-2.7-1.6-4.1-2.4c-0.4-0.2-0.8-0.4-1.2-0.5c0,0.4-0.1,0.8,0,1.2c0.1,2.4,0.3,4.7,0.4,7.1 c0,0.8-0.3,1.4-1.4,1.5c-0.8,0-1.5,0.5-2.3,0.7c-1.1,0.2-2.2,0.4-3.3,0.5c-3.8,0.4-7.5,1.5-11.3,2.4c-0.9,0.2-2,0.1-2.9,0.1 c-1,0-2.1-0.3-2.8,0.1c-1.5,0.9-2.4-0.2-3.5-0.7c-0.9-0.4-1.8-1-2.7-1.4c-2.1-0.7-4.2-1.4-6.4-2c-1.6-0.4-3.3-0.6-4.9-1 c-1.3-0.3-2.6-0.7-3.8-1.2c-1.4-0.5-1.3-2-1.5-3.1c-0.2-1.4-0.5-2.5-1.8-3.2c-1.2-0.6-1.4-1.9-1.5-3c0-0.3,0.3-0.9,0.6-1 c1.2-0.6,1.5-1.6,1.4-2.8c0-0.7,0-1.4,0-2.2c-1.4,0.2-2.6,0.5-3.8,0.7c-0.9,0.1-1.9,0.1-2.8,0.4c-0.9,0.3-1.8,0.8-2.5,1.4 c-0.4,0.4-0.6,1.3-0.4,1.9c0.6,2.1,1.1,4.4,2.2,6.3c1.7,3,2.8,6.3,4.4,9.3c1.1,2,0.3,3-1.9,3.1c-1.9,0.1-3.9,0.5-5.8,0.5 c-3.4,0.1-6.7,1.3-10.1,0.7c-1.7-0.3-3.4,0-5.1,0.2c-1.6,0.1-3.1-0.3-4.7-0.8c-2-0.7-4.1-1.1-6.1-1.6c-0.9-0.2-1.8-0.6-2.7-0.9 c-1.3-0.4-2.5-0.9-3.8-1.3c-0.8-0.2-1.2,0.1-1.2,1c0,0.7-0.1,1.5,0.2,2.2c0.4,1.1-0.3,1.7-1,1.8c-1.4,0.3-2.8,0.3-4.2,0.4 c-0.5,0-1,0.1-1.5,0.2c-2.1,0.3-4.3,0.7-6.4,0.9c-0.6,0.1-1,0.2-1.2,0.9c-0.5,1.6-1.1,3.1-1.7,4.7c-0.1,0.4-0.6,0.9-0.8,0.8 c-0.6-0.2-1.1-0.5-1.5-0.9c-1-1.2-1.9-2.5-2.9-3.7c-0.6-0.8-1.6-1-2.4-0.6c-1.2,0.6-2.2,0.2-3.3-0.1c-2.8-0.9-5.6-1.7-8.3-2.7 c-3-1.1-6-2.3-9-3.4c-0.4-0.1-0.8-0.2-1.2-0.3c-1.5-0.1-3.2-1.8-3.2-3.3c0-1.6,0-3.2,0-4.8c0-1.2-1.1-1.9-2.1-1.3 c-2.4,1.3-4.5,0.5-6.5-0.8c-1.2-0.8-2.2-2-3.2-3.1c-1-1.1-0.6-2.1,0.8-2.5c0.9-0.3,1.8-0.6,2.7-1c1.9-0.9,3.8-1,5.8-0.8 c1.5,0.2,2.4-0.5,2.3-2.1c0-0.9,0-1.7,0-2.6c0-0.9-0.2-1.4-1.2-0.9c-0.5,0.2-1.1,0.3-1.4,0.6c-1.6,1.3-3.6,1.8-5.5,2.3 c-2.5,0.7-5,1.3-7.5,1.9c-1,0.2-2.1,0.2-3.2,0.4c-1.5,0.4-3,0.9-4.5,1.3c-1.1,0.3-1.1,1.2-1.1,2c0,1.6,0,3.3,0,4.9 c0,1.4,0.6,2,2,2c2.6-0.1,5.2,0.4,7.9,0c1.5-0.2,2.9,0.6,4.1,1.5c1.4,1.2,2.8,2.4,4.2,3.6c0.9,0.7,0.8,1.3-0.1,2.1 c-2.3,2-5,2.4-7.7,2.1c-1.9-0.2-3.7-1.2-5.5-1.9c-0.5-0.2-0.9-0.4-1.4-0.4c-0.9,0-1.8-0.1-2.7,0.1c-0.3,0-0.9,0.4-0.9,0.7 c0,2.5-0.1,5,0.2,7.5c0.2,1.9-0.3,2.7-2.2,2.6c-3.7-0.3-7.4,0.2-11,0.9c-2.6,0.5-5.4,0.2-8.1,0.4c-1.2,0.1-2.4,0.6-3.6,0.7 c-0.6,0.1-1.3-0.1-1.9-0.3c-0.6-0.2-1.1-0.5-1.6-0.7c-1.5-0.6-3-1.2-4.5-1.8c-2.2-0.8-4.4-1.5-6.6-2.4c-1.1-0.4-1.9,0.1-2.8,0.3 c-0.6,0.2-1.1,0.4-1.7,0.5c-1.1,0-1.9-0.7-1.8-1.8c0.1-1-0.5-1.5-1.2-1.9c-1.1-0.6-2.2-1.2-3.2-1.7c0.1-1,0.3-2,0.4-3 c0.1-1.3,0.2-2.6,0.2-3.9c0-1-0.2-1.9-0.3-2.9c-0.2-1.8-0.5-3.6-0.8-5.4c-0.1-0.4,0-0.8,0-1.2c0.5-2.3,0.5-2.3-1.4-3.6 c-1.5-1-2.1-2.4-1.4-4c0.3-0.7,1.2-1.3,2-1.7c0.8-0.4,1.3-0.8,1.3-1.7c0-2-0.1-4-0.2-6c0-0.5-0.1-1.1-0.1-1.6 c0.1-2.1,0.4-4.2,0.3-6.2c-0.1-0.9-1.1-1.9-1.9-2.6c-1.3-1.2-1.6-2.6-0.7-4.1c0.1-0.1,0.1-0.3,0.2-0.3c2.9-1.3,2.1-4.1,2.1-6.3 c-0.2-5.2-0.5-10.5,0-15.7c0.2-1.7,0.2-3.4,0.1-5.1c-0.1-2.5-0.3-5-0.5-7.5c-0.1-1.8-0.3-3.7-0.4-5.5c0-1.3,1.1-2.2,2.4-2.3 c2.2-0.3,4.5-0.7,6.7-1.1c0.8-0.1,1.6-0.3,2.3-0.4c1.7-0.1,3.4-0.2,5.1-0.2c0.8,0,1.7,0.3,2.5,0.1c1.2-0.2,2.3-0.5,3.5-1.5 c1.6-1.4,3.8-1.4,5.9-0.7c1.2,0.4,2.4,0.7,3.6,0.8c1.5,0.1,2.3-0.6,2-2c-0.5-2.2,0.7-3.8,1.6-5.6c0.4-0.7,1.2-1.3,1.9-1.8 c1.5-1,2.5-2.4,2.6-4.3c0-0.2,0.1-0.4,0.2-0.6c0.1-0.9,0.5-1.7,1.4-1.5c0.8,0.1,0.8,1,0.9,1.7c0.5,3,1.1,5.9,1.7,8.8 c0.3,1.8-0.4,3.2-1.3,4.6c-0.1,0.2-0.3,0.3-0.4,0.5c1.1,0.4,2,0.8,3,1.1c2.3,0.7,4.5,1.5,6.8,2.1c0.7,0.2,1.5,0.2,2.2,0.4 c2.7,0.8,5.4,1.6,8.1,2.5c1.3,0.4,2.7,0.8,4,1.3c1.4,0.5,2.8,1,4.3,1.5c1,0.3,2,0.6,3.3,0.9c-0.2-2.3-0.5-4.2-0.6-6.1 c-0.1-1.2-0.1-2.5,0.2-3.7c0.3-1.1,1.2-1.7,2.4-1.8c1.6,0,3.3-0.3,4.9-0.4c3.3-0.3,6.6-0.5,9.9-0.8c1-0.1,2-0.4,3-0.6 c0.4-0.1,0.8-0.3,1.3-0.3c2.3-0.3,4.7-0.5,7-0.8c0.3,0,0.7-0.4,0.8-0.6c0.4-1.1,1.3-1.7,2.2-1.5c2.2,0.5,4.3-0.2,6.5-0.5 c0.4-0.1,0.8,0.1,1.2,0c0.6-0.2,1.3-0.4,1.9-0.8c0.5-0.4,1-0.9,1.4-1.5c0.5-0.8,1.2-1.7,1.2-2.5c0-1.4,0.7-2.5,1.5-3.4 c1.2-1.2,2.6-2.3,4.1-3.1c1.3-0.7,2.9-0.9,4.3-1.1c0.3,0,1,0.6,1,0.9c0.1,1.9,0.4,4,0,5.8c-0.5,2.6-1.9,4.7-4.6,5.6 c-1.1,0.3-1.5,2.4-0.6,3.2c0.9,0.7,1.8,1.4,2.8,1.9c2.7,1.2,5.5,2.3,8.3,3.3c0.9,0.3,1.9,0.3,2.8,0.5c2.3,0.4,4.6,0.8,6.9,1.3 c1,0.2,1.2-0.1,1.1-0.9c-0.1-1.5-0.3-2.9-0.2-4.4c0-1.1,0.2-2.2,0.7-3.2c0.6-1.2,2-1,3.1-1c2.7-0.2,5.4-0.3,8.1-0.5 c0.7,0,1.5-0.1,2.2-0.1c2.2,0,4.5,0,6.7-0.1c1.9-0.1,3.8-0.1,5.5-1.1c0.3-0.2,0.7-0.3,0.8-0.5c0.4-1.2,1.5-1.3,2.5-1.7 c1.7-0.6,2.9-1.6,3.2-3.8c0.2-1.1,1.5-2.2,2.6-2.8c2.4-1.5,5-2.8,6.7-5.2c1-1.4,2-1.3,2.9,0.3c1.7,3,1.1,8.5-1.9,10.7 c-0.9,0.7-2,1.3-3.1,2c1.9-0.2,3.8-0.4,5.6-0.6c2.9-0.3,5.7-0.6,8.6-0.9c1.7-0.2,3.3-0.5,4.9-0.8c0.3-0.1,0.7-0.3,0.8-0.5 c0.7-1.7,2.3-2.2,3.8-2.7c1.5-0.6,2.4-2.2,2.1-3.9c-0.3-1.9,0.3-3.4,1.8-4.8c2-1.9,3.8-4,5.7-6c0.4-0.4,1-0.9,1.5-0.9 c0.3,0,0.7,0.8,0.8,1.4c0.9,2.7,1,5.5,0.5,8.2c-0.4,2.5-1.9,4.9-4.7,4.9c-0.3,0-0.7,0.5-0.9,0.9c-0.3,0.7-0.4,1.4-0.7,2.5 c2.9,0,5.6,0.1,8.3,0c3.5-0.2,7.1-0.5,10.6-0.7c2-0.1,4,0.1,6-0.1c1.9-0.2,3.5,0.3,5.2,1.2c2.7,1.4,5.7,2.5,8.6,3.5 c2.7,1,5.4,1.7,8.3,2.6c0-0.4,0.1-0.7,0-0.9c-0.8-1.1-0.1-2.2,0.6-2.5c1.8-0.6,1.9-2.3,2.6-3.7c1-2.2,2.3-2.8,4.5-2.3 c0.9,0.2,1.9-0.1,3.1-0.1c-0.3-0.7-0.5-1.1-0.6-1.6c-0.2-0.7-0.4-1.4,0.4-1.8c0.8-0.4,1.3,0.2,1.7,0.9c0.2,0.5,0.5,1,0.8,1.5 c0.1,0.2,0.4,0.5,0.6,0.5c2.8-0.1,5.7,0.2,8.5-0.4c1.6-0.3,3.2-0.3,4.8-0.4c0.6,0,1.3-0.4,1.9-0.4c0.8,0,1.6,0.1,2.3,0.3 c3.4,1.2,6.7,2.5,10.1,3.7c1.5,0.5,3.2,0.8,4.7,1.1c0.3,0.1,0.5,0.1,0.8,0.3c2.3,1,4.6,2.1,6.9,3.2c0.9,0.4,1,0.8,0.3,1.5 c-0.7,0.7-1.5,1.5-2.2,2.3c0,0-0.1,0.1-0.1,0.1c-0.8,2.1-1.6,4.2-2.3,6.1c0.8-0.1,1.5-0.1,2.2-0.2c0.8-0.1,1.7-0.1,2.2-0.5 c1.5-1.4,3.2-1.2,4.9-1c1.9,0.2,3.8,0.6,5.6,0.9c1.9,0.3,2.2,1,1.5,2.8c-1.6,3.9-5.9,5.1-9.7,4.3c-1.5-0.3-3.1-0.9-4.9-0.2 c-1.4,0.5-2.5,1.5-3.8,1.8c-1.6,0.4-2.1,1.5-2.9,2.6c-1.7,2.3-2.5,5-3.7,7.5c-0.6,1.3-1.4,2.5-2,3.7c-0.7,1.4-1.3,2.8-1.9,4.3 c-0.6,1.5-1.1,3.2-1.8,4.7c-0.9,2.1-1.9,4.2-2.8,6.4c-0.9,2-1.8,4.1-2.7,6.1c-0.2,0.5-0.5,0.9-0.7,1.4 C610,125.7,610,128,610.3,130.3z M392.6,149.4c0.5-0.2,1.1-0.5,1.6-0.9c0,0.3,0,0.6,0,0.9c0,0,0,0.1,0,0.1c0,0,0,0-0.1,0 C393.7,149.5,393.1,149.4,392.6,149.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M617.3,103.6c1.4-4.2,3-8.2,5.3-12c0.7-1.2,1.2-2.5,1.9-3.8c-2.2,0-4.2,0-6.3,0c-1.2,0-2.5-0.1-2.1,1.9 c0,0.1,0,0.2-0.1,0.2c-0.5,0.8-0.2,1.5,0.3,2.2c0.4,0.5,0.7,1.3,0.6,1.9c-0.2,2-0.5,4-1.8,5.7c-0.8,1.1-1.4,2.4-2.2,3.6 c-0.2,0.4-0.6,0.6-0.9,1c-0.3-0.3-0.7-0.6-0.8-1c-0.4-0.9-0.5-1.9-0.9-2.6c-1.6-2.7-1.5-5.4-0.6-8.3c0.3-1.1,0.3-2.3,0.4-3.4 c0-0.2-0.3-0.6-0.5-0.6c-1.6-0.2-3.2-0.2-4.8-0.4c-1.3-0.2-2.4-0.1-2.7,1.6c0,0.2-0.3,0.4-0.4,0.6c-1,2.4-2.6,4.6-2.5,7.4 c0.1,1.4-0.2,2.8-0.4,4.2c-0.3,3.1-0.8,6.2-1,9.3c-0.1,2.8-0.7,5.3-2,7.7c-0.5,1-0.9,2.1-1.2,3c0.8,0.6,1.5,1.1,1.9,1.6 c0.2,0.3,0.1,0.9,0.2,1.3c-0.5-0.1-1.1,0-1.4-0.3c-0.5-0.3-0.7-0.9-1-1.3c-1.3,1.2-2.6,2.3-3.9,3.4c-0.8,0.7-0.9,2.3-0.1,2.9 c2.2,1.4,2.3,4.2,4,5.8c0.1,0.1,0.1,0.4,0.1,0.6c0,1.9,0,3.7,0,5.6c0,0.9-0.7,1.3-1.5,1c-2.6-0.9-4.2-2.9-5.7-5.1 c-0.6-0.8-1.1-1.7-1.6-2.6c-0.1,0.1-0.3,0.1-0.4,0.2c0.1,3.6,0.3,7.2,0.4,11.1c1.3-0.4,2.6-0.9,3.9-1.4c1.5-0.5,3.1-1.1,4.6-1.7 c1.8-0.7,3.6-1.3,5.3-2.1c0.3-0.1,0.7-0.7,0.7-1c-0.4-1.7-0.6-3.6-1.4-5.1c-1-2-1.4-4-1.5-6.1c0-0.4,0.3-0.9,0.5-1.3 c0.1-0.3,0.3-0.6,0.4-1c0.4-1.5,0.8-3,1.3-4.4c0.1-0.4,0.7-1.1,1-1c0.5,0.1,0.9,0.5,1.3,0.9c0.9,1.1,1.7,2.4,2.7,3.4 c2,1.8,2.3,4,1.9,6.4c-0.2,1.4-0.6,2.8-0.8,4.2c-0.1,0.8,0.2,1.4,1,1.5c0.9,0.1,1.6-0.3,1.7-1.2c0.1-2.1,0.3-4.2,0.2-6.3 c-0.1-2.5-0.7-5,0.6-7.4c1-1.9,1.8-3.9,2.8-5.8C614.3,112.5,615.9,108.1,617.3,103.6z M599.5,118.5c0,0.4-0.5,0.7-0.8,1 c-0.1-0.4-0.4-0.7-0.4-1.1c-0.1-0.7,0-1.4,0-2.1c0-0.9-0.1-1.7,0-2.6c0-0.3,0.4-0.7,0.7-0.7c0.2-0.1,0.7,0.3,0.7,0.5 C599.7,115.1,599.7,116.8,599.5,118.5z M602.6,120.6c-0.6-1.9,1-4,2.8-3.9C604.9,118.3,603.9,119.5,602.6,120.6z M608.3,104.2 c-0.3,0.9-0.7,1.7-1.1,2.5c-0.2,0.3-0.7,0.6-1.1,0.6c-0.2,0-0.5-0.5-0.8-0.9c0.5-1.2,0.9-2.4,1.6-3.4c0.2-0.3,1-0.3,1.6-0.4 C608.4,103.2,608.5,103.8,608.3,104.2z M610.1,112c-0.3-1-0.3-2.2-0.4-3.2c0-0.1,0.4-0.3,0.6-0.4c0.3,0.2,0.6,0.2,0.7,0.4 c0.3,1.1,0.6,2.1,0.7,3.2C611.7,112.6,610.3,112.7,610.1,112z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M497.3,153.3c0.7,0,1.5,0.4,2.3,0.6c0.6,0.2,1.2,0.3,1.7,0.4c0.9,0.2,1.7,0.2,2.6,0.4 c1.3,0.4,2.5,0.9,3.7,1.4c1.8,0.6,3-0.2,3-2.1c0-2-0.3-4-0.3-6c-0.1-3.8-0.2-7.5-0.3-11.3c0-1.3-0.7-2.3-1.9-2.6 c-0.8-0.2-1.5-0.4-2.3-0.6c-0.4-0.1-0.8-0.2-1.2-0.3c-0.1,0.5-0.3,1.1-0.2,1.6c0.4,2.7,0.3,5.3-1.6,7.5c-0.8,0.9-1.3,2-1.9,3.1 c-0.1,0.2-0.1,0.5-0.1,0.8c0,0.7,0.1,1.3,0.1,2c0,0.7-0.2,1.2-1.1,1.1c-0.8-0.1-1-0.6-1-1.3c0-0.5,0.1-1.1,0-1.6 c-0.5-2.6-1.1-5.2-1.7-7.8c-0.1-0.6-0.2-1.2-0.3-1.7c-1,0.3-1.8,0.5-2.5,0.7c-0.1-0.1-0.2-0.3-0.3-0.4c0.2-0.3,0.4-0.7,0.7-1 c0.6-0.6,1.4-1.1,2-1.8c0.8-0.8,0.8-2.4-0.1-2.7c-1.5-0.5-3-1-4.6-1.4c-1-0.3-1.5,0.4-1.4,1.5c0.1,0.6,0,1.2,0.1,1.8 c0.1,1.2,0.1,2.4,1,3.4c0.4,0.4,0.4,1.3,0.3,2c-0.1,2.3-1.7,4.5-0.4,6.9c0.1,0.1,0,0.2,0,0.4c-0.2,1.8-0.5,3.7-0.7,5.5 c0.8,0.2,1.5,0.2,2.1,0.5C494.6,153,495.8,153.4,497.3,153.3z M505.4,142.2c0.1-0.1,0.5-0.3,0.6-0.2c0.7,0.4,1.3,1,2,1.4 c-0.1,0.1-0.2,0.3-0.3,0.4c-1,0.3-1.9,0.2-2.3-0.9C505.3,142.8,505.3,142.4,505.4,142.2z M502.6,146.2c0.3-0.1,0.8,0,1,0.2 c0.5,0.7,0.9,1.5,1.3,2.3c0.1,0.2-0.2,0.9-0.3,0.9c-0.6,0-1.3-0.1-1.6-0.4c-0.4-0.6-0.6-1.4-0.8-2.2 C502.3,146.7,502.4,146.3,502.6,146.2z M494,144c0.7,0,1.3,0.1,2,0.2c0.1,0,0.3,0.4,0.3,0.4c-0.1,0.2-0.3,0.5-0.5,0.5 c-0.5,0.1-1.1,0.1-1.9,0.2c-0.1-0.1-0.5-0.4-0.5-0.7C493.3,144.4,493.7,144,494,144z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M627.5,139.8c-0.7,1.4,0.3,4.3,1.8,4.8c1.9,0.8,4.4-0.2,3.9-3.4c0-0.2,0.1-0.7,0-1.1 c-0.2-0.4-0.6-1.1-0.9-1.1c-1.2-0.1-2.4,0-3.6,0.1C628.2,139.1,627.7,139.4,627.5,139.8z M631.2,140.9c0,0.1,0,0.2,0,0.3 c0,0.1,0,0.2,0,0.3c0.1,0.6,0,1-0.2,1.2c-0.1,0.2-0.4,0.2-0.5,0.2c-0.2,0-0.3,0-0.5-0.1c-0.4-0.2-0.8-1.2-0.8-1.8 C630,140.9,630.6,140.9,631.2,140.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M579.2,153.1c-1.3,0.2-2.8,0.3-3.9,0.9c-1.9,1.1-3.8,0.6-5.8,0.5c-1.4-0.1-2.9-0.4-4.5-0.7 c0.2,0.4,0.2,0.7,0.4,0.8c0.7,0.4,1.4,0.9,2.2,1.2c2.5,0.9,5,1.7,7.5,2.5c1.3,0.4,2.6,0.8,3.9,1.1c0.9,0.3,1.3,0,1.6-0.9 c0.2-0.7,0.5-1.4,0.8-2.1C582.2,154.4,581.3,152.9,579.2,153.1z M578.8,157.4c-0.3-0.1-0.5-0.2-0.8-0.2c-0.8-0.2-1.5-0.4-2.3-0.7 c-0.2-0.1-0.4-0.1-0.5-0.2c0.4-0.1,0.8-0.3,1.1-0.5c0.1-0.1,0.3-0.1,0.4-0.2l2.5,0.8C579,156.7,578.9,157,578.8,157.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M596.8,169.8c-3,0.4-4.9,2.9-4.6,6.4c0.6-0.1,1.2-0.2,1.8-0.2c2.6-0.3,3.9-2.2,5.1-4.2 c0.1-0.1,0.1-0.3,0-0.5C599,170.8,597.3,169.7,596.8,169.8z M594.4,173.8c0.4-1.1,1.2-1.8,2.3-2c0,0,0,0,0,0 C596,172.9,595.3,173.6,594.4,173.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M563.8,131.3c1.7-0.3,3.5-0.5,5.2-1c1.5-0.4,2.9-1.1,4.4-1.5c2.3-0.5,4.6-0.7,6.8-1 c0.3-0.1,0.6-0.4,0.9-0.6c-0.2-0.3-0.3-0.7-0.6-0.8c-0.4-0.2-0.9-0.2-1.4-0.2c-0.3,0-0.7,0.2-1,0.2c-1.2,0.1-2.4,0-3.6,0.1 c-1,0.1-2,0.6-3,0.6c-2.3,0.1-4.6-0.1-6.8,0.1c-2.4,0.1-3.9-1.4-5.3-2.9c-0.3-0.3-0.1-1.1,0-1.7c0.2-0.7,0.6-1.3,1-1.9 c-0.1-0.1-0.2-0.1-0.3-0.2c-0.4,0.2-0.7,0.5-1.1,0.7c-1.6,1.3-2.1,5.3-0.8,6.7c1.5,1.7,4,1.6,5.6,3.2 C563.7,131.3,563.8,131.3,563.8,131.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M634.7,132c0,0.2,0.4,0.2,0.6,0.4c0.2,0.2,0.4,0.5,0.7,0.9c-0.8,0-1.6-0.2-1.9,0c-0.6,0.7-1.1,1.6-1.6,2.5 c0.4,0,0.7,0,1.1,0.1c0.5,0.1,1.1,0.1,1.6,0.2c0.6,0.2,1.2,0.6,2,1c0,0.6,0,1.4,0,2.3c0.1,2.6-0.7,4.9-2.4,6.9 c-0.3,0.3-0.6,0.7-0.6,1.1c-0.2,1.8-0.3,3.6-0.5,5.5c-0.1,1.1,0.7,1.7,1.6,1.8c1.4,0.1,2.9-0.1,4.3-0.3c0.3,0,0.8-0.8,0.7-1.1 c-0.5-1.1-0.1-2.1,0.2-3.1c0.2-0.6,0.4-1.3,0.2-1.8c-0.4-0.9-0.5-1.8-0.5-2.8c0-2.6-0.3-5.1-0.4-7.7c-0.1-2.4-0.1-4.8-0.3-7.2 c-0.1-0.8-0.8-2-1.4-2.1c-2-0.3-4.1-0.1-6.1,0.7C633.2,129.9,634.3,130.5,634.7,132z M638.1,145c0,0.3,0,0.5,0,0.8 c0,1,0.1,2.1,0.6,3.3c0,0.1-0.1,0.3-0.1,0.4l-0.1,0.5c-0.2,0.7-0.5,1.6-0.4,2.6c-0.8,0.1-1.5,0.1-2.3,0.1c0.1-1.7,0.2-3.3,0.4-4.9 c0,0,0.1-0.1,0.1-0.2C637,146.8,637.6,145.9,638.1,145z M637.6,135.1C637.6,135.1,637.6,135.1,637.6,135.1 c-0.2-0.1-0.3-0.1-0.3-0.2c0.1-0.1,0.2-0.2,0.3-0.3C637.6,134.7,637.6,134.9,637.6,135.1z M637.2,130.7c0.1,0.1,0.2,0.3,0.2,0.3 c0,0.3,0.1,0.6,0.1,0.9l-0.1-0.1c-0.2-0.3-0.4-0.5-0.6-0.8c-0.1-0.1-0.2-0.2-0.3-0.3c0,0,0,0,0,0 C636.6,130.7,636.9,130.7,637.2,130.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M623.4,177.6c-0.3,0.5-0.6,1.1-0.9,1.2c-1.1,0.2-1,0.9-0.7,1.7c0.6,1.4,1.3,2.8,1.9,4.2 c0.3,0.7,0.7,0.8,1.1,0.3c0.4-0.4,0.8-1,0.7-1.5c-0.1-1.4-0.4-2.7-0.7-4.1C624.9,178.3,624.2,177.9,623.4,177.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M629.6,148.7c0,1.4,0.1,2.8,0.2,4.2c0,0.4,0.2,0.9,0.3,1.6c1.6-2.4,0.6-4.6,0.1-6.8 C629.9,147.9,629.6,148.3,629.6,148.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M454.8,165.6c-0.6,0-1.2-0.2-1.8-0.4c-1.7-0.6-3.4-1.3-5.1-2c-0.9-0.4-1.9-0.7-2.8-1.1 c-0.2,0.5,0.5,3.5,0.9,3.7c0.1,0.1,0.3,0,0.5,0.1c3.1,0.9,6.3,1.7,9.4,2.6c0.3,0.1,0.7,0.1,1.2,0.1c-0.2-0.6-0.4-1.1-0.5-1.5 C456.3,166,455.8,165.6,454.8,165.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M445.8,141.3c0.5,0.1,0.9,0.3,1.4,0.3c1,0.1,1.9,0.1,2.9,0.2c0.4,0,0.9,0.2,1,0.5c0.3,0.8,0.5,1.6,0.8,2.5 c1.1,3.5,2.1,7,3.2,10.5c0.3,0.9,0.7,1.8,1,2.7c2.1-1,4-2,5.8-3c0.4-0.2,1-0.7,1-0.9c-0.2-1-0.7-1.9-1-2.9 c-0.5-1.6-1.4-3.1-1.5-4.7c-0.1-2.6,0.4-5.3,0.6-7.9c0-0.3,0.3-0.7,0.5-1c0.3,0.2,0.7,0.3,1,0.6c0.9,0.9,1.8,1.9,2.7,2.7 c1.3,1.3,2.4,2.7,2.4,4.7c0,1.1,0,2.2,0.1,3.3c0.1,0.6,0.3,1.3,0.7,2.3c2.1-2,3.9-3.6,5.7-5.4c0.3-0.3,0.5-1,0.4-1.4 c-0.6-1.7-1.4-3.3-1.9-5c-0.3-1.2-0.3-2.5,0-3.7c0.4-1.3,1.4-2.4,2.1-3.6c0.5-0.9,1.1-1.7,1.5-2.6c1.1-2.8,2.2-5.7,3.2-8.6 c1.4-3.8,2.3-7.7,2.5-11.7c0.2-3.5-1-6.7-1.8-9.9c-0.1-0.2-0.2-0.4-0.3-0.5c-0.7-0.9-1.6-1.7-1.9-2.7c-0.9-3-2.9-5.2-4.7-7.6 c-0.6-0.9-1.7-1.4-2.6-2c-1.1-0.8-2.4-1.1-3.6-1.6c-1.7-0.7-3.2-1.7-5.1-2.1c-1.7-0.4-3.2-0.6-4.9-0.6c-1.7,0.1-3.5-0.1-5.2,0 c-1.5,0.1-1.9,0.7-1.7,2.2c0.1,0.6,0.1,1.3,0.2,1.9c0.2,1.7,0.3,3.3,0.5,5c0,0.5,0.2,1,0.1,1.5c-0.4,2.8,0.5,5.3,0.9,8 c0,0.3,0.2,0.6,0.1,0.9c-0.3,2.3-0.1,2.7,2.2,2.8c1.9,0.1,3.4,1.4,4.3,2.8c0.9,1.4,1.1,3.3,1.4,5c0.4,2.8-0.9,4.9-3.1,6.5 c-2.6,1.9-5.7,2.3-8.7,3.3c-0.7,0.2-1.6,0.3-2.2,0.7c-2.9,1.6-5.7,3.3-8.5,5c-3.2,2.1-6,4.9-9.5,6.5c-0.8,0.3-1.4,1.1-2.1,1.6 c-1.3,1.1-0.6,2.6-0.7,3.9c0,0.2,0.8,0.5,1.2,0.8c0.2,0.1,0.4,0.2,0.5,0.4c0.7,1.3,1.6,2.5,1.4,4.1c-0.4,2.4-0.8,4.9-1.3,7.3 c-0.4,1.9-1.5,2.1-2.9,0.7c-0.4-0.4-0.7-1-1.1-1.4c-0.2-0.3-0.4-0.6-0.7-0.8c-0.3-0.2-0.7-0.4-1.1-0.3c-0.2,0-0.3,0.6-0.3,1 c0,1.5,0.2,3.1,0.2,4.6c0,1.3,0.6,1.8,1.8,2c0-0.3,0.1-0.4,0.1-0.6c0.1-0.8,0-1.6,0.3-2.3c0.2-0.4,0.9-0.5,1.3-0.8 c0.2,0.5,0.6,1,0.6,1.4c-0.1,0.8-0.4,1.5-0.7,2.5c0.8-0.1,1.5-0.3,2-0.3c-0.3-1.1-0.6-2-0.7-2.9c0-0.9,0.8-1.3,1.3-0.7 c0.6,0.7,1.2,1.5,1.4,2.3c0.2,0.8,0.5,1.2,1.2,1.1c0.7-0.1,1.1-0.3,1.3-1.3c0.2-1.2-0.2-2.2-0.7-3.3c-0.2-0.5-0.4-1.1-0.3-1.6 c0.2-1,0.7-1.9,1-2.9c0.7-1.9,1.3-3.9,1.9-5.7c-0.5-0.4-1.2-0.6-1.3-0.9c-0.5-1.6-0.8-3.3-1.1-5c-0.1-0.3,0.3-0.7,0.5-1 c0.3,0.3,0.6,0.5,0.7,0.8c0.6,1.4,1.2,2.8,1.9,4.5c0.2-0.3,0.3-0.5,0.4-0.7c1-1.4,2-1.3,2.8,0.3c0.2,0.4,0.4,0.7,0.6,1.1 c0.6,1.1,1.4,2.1,1.7,3.3c0.5,2,0.3,4.1-0.5,6c-0.3,0.8-0.6,1.6-1,2.7c1.9-0.2,3.9,0.4,4.9-1.7c0.3-0.5,0.7-1.4,0.4-1.7 c-0.8-1.3-0.4-2.5-0.4-3.8c0.1-1.2,0.2-2.5,0.5-3.7C443.1,141.9,444.4,141.1,445.8,141.3z M464.2,135.8c0.4-0.6,0.8-1.2,1.3-1.7 c0.2-0.3,0.6-0.4,1.3-0.8c0.2,0.5,0.5,1.1,0.4,1.2c-0.7,0.8-1.5,1.5-2.3,2.2c-0.1,0.1-0.6-0.1-0.8-0.2 C464.1,136.3,464.1,136,464.2,135.8z M459.2,132c0.2-0.8,1.1-1.1,1.7-0.6c0.8,0.7,1,3.1,0.2,3.8c-0.3,0.3-0.8,0.6-1.2,0.6 c-0.2,0-0.5-0.6-0.6-1c-0.1-0.5-0.2-1-0.2-1.4C459.1,132.8,459.1,132.3,459.2,132z M456.1,136.5c1.1,0,2.9,1.9,2.8,2.7 c0,0.6-1,1.2-1.6,0.7c-0.7-0.7-1.3-1.6-1.8-2.5C455.5,137.3,455.9,136.7,456.1,136.5z M435.3,137.9c-0.1,0.2-0.7,0.5-0.8,0.4 c-0.3-0.3-0.7-0.7-0.6-1c0.2-1.3,0.4-2.6,0.8-3.9c0.1-0.3,0.8-0.8,1.1-0.7c0.4,0.2,0.7,0.8,1,1.2 C436.3,135.3,435.8,136.6,435.3,137.9z M441.1,135.8c-0.6,0.9-1.2,1.9-1.9,2.7c-0.2,0.2-0.7,0.5-0.9,0.4c-0.2-0.1-0.4-0.6-0.4-0.9 c0.1-0.6,0.3-1.2,0.6-1.6c0.9-1.3,1.9-2.6,3.9-2.6C442,134.5,441.6,135.2,441.1,135.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M439.5,163.1c-1.4,0.3-2.9,0.6-4.3,0.8c-2.2,0.3-4.5,0.4-6.7,0.7c-0.3,0-0.7,0.2-1,0.4c-1.1,0.8-1.9,2,0,3 c0.9,0.5,1.9,1.2,2.5,2c1.1,1.7,1.6,2.1,3.6,1.8c2.7-0.3,5.4-0.6,8.1-0.9c0.5-0.1,1-0.2,1.2-0.3c-0.4-2.8-0.8-5.3-1.2-8.2 C440.8,162.7,440.2,163,439.5,163.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M447.7,155.2c1.6,0.7,3.3,1.3,5.3,2.1c-0.1-0.6-0.2-0.9-0.3-1.2c-0.5-1.9-1-3.8-1.6-5.7 c-0.6-1.7-1.3-3.3-2-5c-0.6-1.4-2.6-1.8-3.7-0.7c-0.2,0.2-0.5,0.6-0.5,0.9c-0.1,1.1-0.3,2.3-0.2,3.4c0.2,1.7-0.1,3.6,1.3,5 C446.3,154.5,447,154.9,447.7,155.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M372.8,165.5c0.1,0,0.4-0.3,0.6-0.5c-0.3-0.3-0.6-0.6-1-1c-0.5,0.3-0.8,0.5-1.1,0.7 C371.8,165.1,372.3,165.4,372.8,165.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M464,160.8c0.7-0.3,1.4-0.6,2-1c2.5-1.7,4.9-3.3,7.3-5.1c1.2-0.9,2.3-1.8,3.4-2.8c0.8-0.7,1.1-1.6,0.2-2.5 c-0.2-0.2-0.2-0.7-0.4-1.1c-0.1-0.4-0.3-0.7-0.6-1.3c-2.2,2.8-5.5,3.9-7.4,6.9c-0.8,1.3-2.6,1.9-3.9,2.9c-2.4,1.8-5.4,2.4-8,3.7 c-0.9,0.5-2,0.5-2.8-0.2c-1.7-1.6-4.1-1-6-2.1c-0.6-0.4-1.1,0.2-1.1,0.8c0,0.4,0.1,1.1,0.3,1.3c1.9,1,3.8,2,5.8,2.8 c1.2,0.4,2.5,0.4,3.8,0.5c0.9,0,2,0,2.8-0.3C461,162.4,462.4,161.5,464,160.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M474.2,156.2c-1.2,0.8-2.3,1.6-3.5,2.4c-1.9,1.2-3.9,2.5-5.9,3.6c-1.5,0.8-3,1.5-4.5,2.3 c-0.7,0.4-1.7,0.8-1.9,1.4c-0.2,0.6,0.5,1.5,0.7,2.3c0.2,1,0.8,1.6,1.7,1.8c0.7,0.2,1.5,0.3,2.2,0.3c2.7,0,5.4,0,8.1,0 c0.7,0,1.4,0,2.2-0.1c2.3-0.3,4.6-0.6,6.9-0.9c1.2-0.2,2.4-0.3,4-0.5c-2.4-4.9-4.6-9.6-7-14.5 C476.2,154.9,475.2,155.5,474.2,156.2z M461.4,168c-0.1,0-0.2,0-0.2-0.1l0.7,0.2C461.8,168.1,461.6,168.1,461.4,168z M478.4,167.5 c-1.7,0.2-3.5,0.5-5.2,0.7c-0.4,0.1-1,0.1-1.4,0.1l-2.2,0c-0.4,0-0.7,0-1.1,0L478.4,167.5L478.4,167.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M441.8,156.3c-1.8,0.2-3.7,0.6-5.4,1.2c-1.3,0.4-2.5,1.3-3.8,1.6c-3.1,0.7-6.3,1.3-9.5,0.8 c-1-0.2-2.1-0.1-3.2-0.3c-2.3-0.4-4.7-0.8-7-1.2c-1-0.2-2.2,0.1-2.9-0.4c-2.4-1.5-5.3-1.4-7.9-2.3c-0.8-0.3-1.7-0.5-2.6-0.5 c-0.4,0-0.9,0.2-1.2,0.5c-0.2,0.2-0.2,0.9,0,1.1c0.6,0.6,1.2,1.6,2.2,0.8c0.6,0.5,1,1,1.5,1.2c3.4,1.2,6.8,2.3,10.2,3.4 c0.8,0.3,1.5,0.3,2.2-0.5c0.2-0.2,0.8-0.3,1.1-0.2c1.5,0.8,3.3,0.6,4.9,1c2.3,0.6,4.8,0.2,7.2,0c3.1-0.3,6.2-0.8,9.3-1.3 c1.8-0.3,3.6-0.8,5.3-1.3c0.9-0.2,1.1-1,0.9-1.7C442.8,157.6,442.2,156.3,441.8,156.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M388.1,103.1c1.4,0,2.8-0.4,3.9-1.7c-0.8-0.6-1.6-1-2.2-1.5c-1.7-1.5-4.4-1.6-6.1-0.1 c-0.8,0.7-0.6,2.3,0.4,2.6C385.5,102.6,386.8,103.1,388.1,103.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M434.1,152.5c0.3-0.1,0.6-0.3,0.9-0.4c2.4-1.3,2.9-5.7,0.4-7.9c-0.6,1.3-1.3,2.6-1.8,3.9 c-0.4,1-0.7,2-0.9,3C432.3,152.5,432.8,152.9,434.1,152.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M399.7,153c2.4,1.3,5.1,1.7,8.1,2c-0.2-1-0.3-1.9-0.5-2.8c-0.3-1.6-1.6-2.9-1.3-4.6c0-0.2-0.4-0.6-0.7-0.6 c-2.1-0.3-4.3-0.7-6.4-0.9c-0.2,0-0.7,0.5-0.8,0.9c-0.1,0.8,0,1.5,0,2.3C397.9,150.2,398.9,152.6,399.7,153z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M463,142c-0.3,1.7-0.6,3.1-0.7,4.4c0,0.7,0.3,1.4,0.6,2.1c0.1,0.2,0.3,0.4,0.5,0.4 c0.7,0.1,2.4-1.5,2.5-2.3C466.2,144.3,464.6,143.3,463,142z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M484.6,138.4c0.8,0.2,1.7,0.2,2.6,0.3c1.5,0.1,2.1-0.9,1.9-2.4c-0.3-1.8-0.4-3.6-0.3-5.5 c0-1.1,0-2.1-0.5-3.2c-0.5-1.2-1.7-2.1-1.2-3.7c0.2-0.7,0.3-1.4,1-1.9c0.3-0.3,0.5-0.8,0.5-1.2c0-4.7,0-9.3,0-14 c0-0.4-0.3-1-0.7-1.2c-0.9-0.5-1.9-0.8-2.9-1.1c-0.4-0.1-0.8-0.2-1.2-0.3c-0.1,0.5-0.2,0.9-0.2,1.4c0.3,2.4,0.9,4.8,0.4,7.3 c-0.2,1-0.4,2.1-0.7,3.1c-1.1,3.7-2,7.5-3.5,11.1c-1.3,3.3-3.3,6.3-4.9,9.5c-0.2,0.4-0.5,1.1-0.4,1.5c0.7,1.9,1.5,3.7,2.3,5.5 c2-0.5,2.9-2.1,4-3.5C482,138.9,482.9,137.9,484.6,138.4z M485.9,136.6c-0.7,0-1.2-0.3-1.2-1.1c0-0.3,0-0.6,0-0.9 c-0.1,0-0.2-0.1-0.2-0.1c0.3-0.6,0.4-1.4,0.9-1.9c0.5-0.6,1-0.4,1.1,0.5c0.1,0.8,0.2,1.5,0.2,2.3 C486.6,135.9,486.7,136.6,485.9,136.6z M479.5,138.8c-0.2,0.2-0.3,0.4-0.5,0.6c-0.2,0.3-0.4,0.6-0.6,0.8l-1.4-3 c0.5-1,1-1.9,1.6-2.8c1.2-2.1,2.4-4.3,3.3-6.6c0.3-0.8,0.6-1.6,0.9-2.5c2.4-4.1,3.7-8.9,4-14.1c0,3,0,6.1,0,9.4 c-0.8,0.8-1.1,1.7-1.3,2.4l-0.1,0.3c-0.7,2.1,0.3,3.6,0.9,4.5c0.2,0.2,0.3,0.5,0.4,0.7c0.3,0.6,0.3,1.2,0.3,2.1 c-0.3-0.2-0.7-0.2-1-0.2c-0.8,0-1.5,0.4-2.1,1c-0.5,0.6-0.8,1.3-1,1.9c-0.1,0.2-0.1,0.3-0.2,0.5c-0.2,0.5-0.2,1,0,1.5 c0,0.1,0.1,0.1,0.1,0.2c0,0,0,0,0,0.1c0,0.3,0.1,0.7,0.2,0.9C481.1,136.8,480,138.1,479.5,138.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M401.5,138.7c1.2-1.5,2.3-3,3.5-4.4c1.9-2.2,2.8-5,3.5-7.8c0.7-2.7,1-5.4,1.4-8.2c0.2-1.6,0.3-3.2,0.3-4.7 c0-1.5-0.3-2.9-0.5-4.4c-0.4-3-0.8-6-2.8-8.4c-0.5-0.7-1.1-1.3-1.5-2.1c-1.2-2-2.6-3.9-4.8-5c-1.6-0.8-3.1-1.9-4.6-2.7 c-1.2-0.7-2.5-1.2-3.8-1.7c-1-0.4-2-0.6-3-0.9c-1.8-0.5-3.5-1.4-5.3-1.1c-2.1,0.4-4.2,0.2-6.3-0.3c-1-0.2-2.1,0-3.2,0 c0,0.2,0,0.3,0,0.5c0.2,0.3,0.4,0.6,0.6,0.9c1.5,2.1,2.9,4.3,3.5,6.9c0.2,0.6,0.5,1.6,0.9,1.7c1.1,0.3,2.4,0.4,3.6,0.3 c0.8-0.1,1.6-0.8,2.5-0.9c1.4-0.2,3.1-0.4,4.3,0c1.7,0.7,3.3,2,4.8,3.1c0.3,0.2,0.5,1.1,0.3,1.4c-0.7,0.9-1.6,1.7-2.4,2.5 c-2.1,2.1-4.6,1.8-7.2,1.4c-1-0.2-2.2,0.2-3.1,0.7c-0.3,0.1-0.1,1.3-0.2,2c0,0.4,0,0.7,0.1,1.1c0.3,1.3,0.2,2.9,0.9,3.9 c1.3,1.8,1.8,3.9,2.2,5.9c0.4,2.2,0,4.2-2,5.5c-0.9,0.6-1.7,1.4-2.7,1.8c-1.1,0.5-2.3,1.1-3.3,1c-2.6-0.2-5.3,0.2-7.7-1.2 c-0.3-0.2-0.9,0-1.3,0.1c-3.3,0.8-6.7,1.2-10.1,1.2c-2.7,0-5.4,0.4-8.1,0.6c-1,0.1-1.9-0.1-2.9-0.1c-1.7,0.1-2.1,0.6-2.1,2.3 c0,0.2,0.1,0.5,0.1,0.7c-0.1,0.7-0.3,1.3-0.4,1.9c-0.1,0.4-0.2,0.8-0.2,1.2c0,1.8,0.1,3.6,0.2,5.5c0.2,2.9,0.4,5.9,0.6,8.8 c0.1,2,0.2,4,0.4,6c0.2,2,0.4,4.1,0.8,6.1c0.1,0.6,0.9,1.4,1.5,1.6c1.4,0.3,2.9,0.4,4.4,0.4c0.6,0,1.3-0.1,1.8-0.5 c0.7-0.5,0.9-2.8,0.4-3.6c-0.8-1.3-1.1-2.7-0.5-4.1c1-2.7,2.2-5.3,3.3-7.9c0.2-0.4,0.7-0.6,1.1-0.9c0.3,0.4,0.6,0.8,0.8,1.2 c1,2.3,1.9,4.6,3,6.9c0.9,1.8,0.8,3.8-0.5,5.3c-0.5,0.6-1,1.2-0.1,2c0.1,0.1,0.2,0.3,0.2,0.4c0.1,1.7,0.2,1.8,1.9,1.8 c1.6-0.1,3.3-0.3,4.9-0.3c1.2-0.1,1.5-0.5,1.4-1.7c-0.3-2.3-0.5-4.7-0.7-7c-0.1-1.2,0.3-2.4,1.4-2.9c1-0.4,2.1-0.6,3.2-0.8 c1.2-0.2,2.4-0.4,3.6-0.6c0.6-0.1,1.2-0.2,1.9-0.3c1.3-0.2,2.7-0.3,4-0.5c1-0.2,1.9-0.7,2.8-1c1.7-0.5,3.5-0.7,5-1.5 C394.8,144,398.7,142.2,401.5,138.7z M352.9,148.3c-0.4-0.7-0.7-1.4-0.8-2.1c-0.1-0.3,0.4-0.8,0.5-1.1c0.4,0.1,0.6,0.1,0.6,0.2 c0.3,1,0.8,2.1,0.8,3.1C354.1,148.9,353.2,148.8,352.9,148.3z M358.5,141.8c-0.1,0.4-0.6,0.9-0.9,0.9c-0.4-0.1-0.7-0.6-1-0.9 c0.1-0.1,0.2-0.2,0.2-0.2c0.1-0.7,0.1-1.4,0.3-2.1c0.1-0.4,0.6-0.7,0.9-1.1c0.2,0.4,0.6,0.9,0.6,1.3 C358.7,140.4,358.7,141.1,358.5,141.8z M364.3,144.7c-0.7,0.8-1.3,1.6-2.1,2.3c-0.2,0.2-0.8,0-1.3-0.1c0-0.4,0-0.9,0.2-1 c1-0.9,2.1-1.7,3.1-2.5c0.1,0.1,0.2,0.2,0.4,0.3C364.5,144.1,364.5,144.5,364.3,144.7z M373.4,148c-0.2,0-0.4,0.1-0.6,0.1 c-0.2,0-0.4,0.1-0.6,0.1c0.1-0.2,0.3-0.3,0.6-0.3l1.9-0.1C374.2,147.9,373.8,147.9,373.4,148z M396.2,96.2 c0.7-0.5,1.7-0.7,2.5-0.9c0.3-0.1,0.8,0,0.9,0.2c0.2,0.3,0.2,0.8,0.1,1.1c-0.8,1.5-2.4,1.6-4,2.3c-0.2-0.3-0.7-0.7-0.6-0.9 C395.4,97.3,395.7,96.6,396.2,96.2z M395.1,107.1c-0.4-0.7-0.6-1.5-0.7-2.3c0-0.1,0.4-0.5,0.6-0.5c0.3,0,0.7,0.2,0.9,0.5 c0.4,0.4,0.6,0.9,1.2,1.8C396.3,106.8,395.2,107.3,395.1,107.1z M398.2,103.5c-0.5-0.2-1.2-0.3-1.3-0.7c-0.1-0.4,0.2-1,0.5-1.5 c0.1-0.2,0.5-0.2,0.7-0.2c0.6-0.1,1.3-0.1,1.9-0.2c0.2,0,0.5,0,0.7,0.1c0.1,0.1,0.1,0.4,0,0.6 C400.3,102.9,399.6,103.5,398.2,103.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M487.7,140.8c-0.2,0-0.4,0-0.6,0c-2.7-0.9-4.5,0.4-5.7,2.6c-0.3,0.5-0.1,1.4,0,2.1c0,0.2,0.6,0.5,0.9,0.6 c0.9,0.1,1.8,0,2.7,0c2.3,0,4-1.1,4.5-2.9C490.1,141.3,489.6,140.6,487.7,140.8z M485,144.1c-0.3,0-0.5,0-0.8,0 c-0.3,0-0.6,0-0.9,0c1-1.6,1.8-1.6,2.2-1.6c0.3,0,0.7,0.1,1,0.2c0.3,0.1,0.6,0.1,1.1,0.1C487.1,143.9,485.7,144.1,485,144.1z"})
            ), 
            React.createElement("g", null, 
              React.createElement("path", {fill: "#FFFFFF", d: "M91.2,104.6c2.1,1.3,4.8,1.7,7.4,0.3c0.4-0.2,1-0.2,1.5-0.3c3.1-0.1,6.3-0.2,9.4-0.3 c0.5,0,1.3-0.3,1.5-0.7c0.2-0.4-0.2-1.1-0.4-1.6c-0.1-0.3-0.2-0.5-0.4-0.7c-0.8-0.9-1.4-1.8-2.4-2.5c-1.3-1-2.7-0.7-4-1 c-0.9-0.2-1.9-0.4-2.8-0.4c-1.4,0-2.8,0.3-4.1,0.4c-1.6,0.1-3.2,0.2-4.8,0.2c-0.6,0-1.4-0.2-1.9,0.1c-1.7,0.9-3.5,0-5.3,0.3 c-2.2,0.4-4.5,0.3-6.8,0.5c0,0.1,0,0.3,0,0.4c1.6,0.8,3.1,1.6,4.7,2.3C85.4,102.8,88.4,102.9,91.2,104.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M146.8,122.5c-1.1-0.5-1.9-0.1-2.3,1.1c-0.7,1.9-0.6,3.8,0.1,6.1c1.2-0.7,2.3-1.2,3.1-2 c1-1.1,1.2-2.5,1-4.1C148.6,122.4,147.5,122.9,146.8,122.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M147.4,118.4c-0.2,0-0.5,0.3-0.7,0.4c0.2,0.2,0.3,0.6,0.5,0.7c0.7,0.3,1.4,0.6,2.1,0.9 C149.8,119.3,148.9,118.3,147.4,118.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M103.8,94c1,0.4,2.1,0.6,3,1c1,0.4,2.2,0.8,2.8,1.7c1,1.2,1.6,2.7,2.4,4.2c0.8,1.7,1.7,3.3,2.3,5.1 c0.6,1.6,0.6,1.8,2.4,1.8c0-0.3,0-0.5,0-0.7c-0.2-1.6-0.4-3.1-0.8-4.6c-0.3-1.1-0.8-2.2-1.4-3.1c-1.1-1.4-2.5-2.6-3.6-4.1 c-1.4-2-3.6-2.7-5.7-3.6c-1.1-0.5-2.5-0.2-3.8-0.3c-2-0.2-4-0.2-6,0.5c-1.4,0.5-2.6,1.3-3.5,3c1.8-0.2,3.3-0.3,4.8-0.5 C99.1,93.9,101.4,93.1,103.8,94z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M131.1,100.1c0.3,0.2,0.6,0.6,0.5,1c0,0.4-0.4,0.7-0.6,1c0.5,1.2,1.4,0.9,2.2,0.5 c-0.1-0.1-0.2-0.2-0.2-0.3c0.3-0.7,0.5-1.5,1-2.1c1.1-1.7,0.5-4.1-1.8-5.2c-1.5-0.7-1.4,1.3-2.1,2c-0.1,0.1-0.2,0.2-0.2,0.3 c-0.1,0.8-0.2,1.6-0.1,2.4C129.8,99.9,130.7,99.9,131.1,100.1z M131.8,98.1C131.8,98.1,131.8,98.1,131.8,98.1 c0.1-0.2,0.2-0.4,0.3-0.6c0.2,0.2,0.3,0.4,0.3,0.6c0.1,0.2,0.1,0.4,0,0.6c-0.1-0.1-0.2-0.2-0.3-0.2c-0.1-0.1-0.2-0.1-0.4-0.2 C131.8,98.2,131.8,98.1,131.8,98.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M119.3,102.8c1.4-0.3,2.7-0.6,4-1.1c0.5-0.2,0.8-0.7,1.4-1.1c-2.7-0.7-5.1-1.4-7.6-2.1 c0.5,1.3,0.9,2.7,1.4,4C118.6,102.6,119.1,102.8,119.3,102.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M119.3,106.7c0.5,1,1,2.2,2.2,2.7c1.7,0.7,3.5,0.3,5.2,0.2c1.9-0.1,2.2-0.4,2.5-2.5c-0.3-0.5-0.7-1-1-1.6 c-0.6-1.2-1.7-1-2.7-1c-1.6,0.1-3.2,0.2-4.7,0.5C120.3,105.3,119.2,106.5,119.3,106.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M95,185.2c3.5,0.3,5.1-3.1,4.2-5.7C96.9,179.9,94.9,182.6,95,185.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M91.3,194.3c0.2,0.1,0.5,0,0.8,0.1c0.2-2.2,0.4-4.4,0.6-6.5c0-0.2-0.2-0.5-0.3-0.8c-1-1.4-1-2.2,0.1-3.5 c0.3-0.3,0.6-0.8,0.6-1.2c0-0.8-0.2-1.6-0.2-2.4c-0.1-2.2,0-4.4-0.1-6.5c0-0.4-0.3-0.9-0.6-1.1c-0.8-0.6-1.6-1.1-2.5-1.5 c-2.8-1.4-5.9-1.4-8.8-2c-0.5-0.1-1-0.3-1.4-0.2c-1.4,0.4-2.7,0-4.1-0.5c-0.6-0.2-1.2-0.4-1.8-0.5c-0.7-0.1-1.1,0.1-1,0.9 c0.2,1.9,0.3,3.7,0.5,5.6c0.2,2.5,0.5,5,0.6,7.5c0.1,1,0,2-0.2,3c-0.3,1.5-0.1,2.4,1.2,3c1.5,0.8,3,1.5,4.6,2.1 c2.4,1,4.9,2.3,7.4,2.8C88.3,193,89.8,193.5,91.3,194.3z M75,173.9c-0.1-0.6-0.1-1.3-0.2-1.9c-0.1-0.7-0.1-1.3-0.2-2 c0.1,0,0.2,0.1,0.3,0.1l0.2,5.2C75.1,174.9,75.1,174.4,75,173.9z M75.3,185.8c0-0.1,0-0.3,0.1-0.7c0,0,0,0,0-0.1l0,0.8 C75.4,185.8,75.3,185.8,75.3,185.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M72.5,112.2c0,2.4,0,4.8,0,7.2c0,2.7,0,5.4,0,8.1c0,2.4,0.1,4.8,0.1,7.2c0.1,2.4,0.1,4.9,0.3,7.3 c0.4,4.6,0.5,9.2,0,13.8c-0.3,3.4-0.6,3.5,2.7,4.8c0.3,0.1,0.5,0.2,0.8,0.2c0.8,0,1.8,0.2,2.2-0.2c0.7-0.8,0.4-2-0.1-3 c-0.1-0.1-0.1-0.2-0.2-0.3c-0.6-1.1-0.6-2.2-0.4-3.4c0.4-2.8,2.5-4.7,3.7-7c0.2-0.4,0.5-0.8,0.8-1c0.2-0.2,0.8-0.3,0.9-0.2 c0.7,1.2,1.5,2.4,2.1,3.6c0.5,1.2,0.8,2.5,1.2,3.7c0.6,1.7,0.2,3.1-0.8,4.4c-0.7,0.9-0.5,4.2,0.3,4.9c0.3,0.2,0.8,0.5,1.1,0.4 c1.5-0.3,2.7,0.2,4,0.8c0.9,0.4,1.3,0.1,1.2-0.9c0-0.8,0-1.5,0.1-2.3c0-1,0.1-2,0.1-3.1c0-0.9,0-1.9-0.1-2.8 c0-1.2-0.1-2.3-0.2-3.5c-0.1-1.1-0.3-2.1-0.3-3.2c0-4.6,0-9.1,0-13.7c0-1.5-0.1-2.9-0.1-4.4c0-3,0.1-6,0.1-9 c0-1.8-0.1-3.5-0.2-5.3c-0.1-1.9-0.1-3.9-0.3-5.8c-0.1-0.7-0.5-1.5-0.9-2c-1-1.1-2.2-1.9-3.8-2.2c-1.4-0.3-2.8-0.6-4.1-1.1 c-2.1-0.7-4.2-1.6-6.3-2.4c-1.3-0.5-2.6-0.9-4.1-1.4c-0.1,1-0.3,1.8-0.2,2.5c0.1,1.2,0.4,2.3,0.4,3.5 C72.7,108.6,72.5,110.4,72.5,112.2z M86.4,144.4c0.6-0.6,1.4-1.1,2.2-1.4c0.6-0.2,0.9,0.4,0.8,1c-0.1,1-1.3,2-2.5,2 c-0.1-0.1-0.6-0.2-0.6-0.4C86.2,145.2,86.2,144.6,86.4,144.4z M83.8,138.7c0-0.2,0.6-0.4,0.6-0.3c0.3,0.4,0.5,0.8,0.6,1 c-0.1,1.1-0.1,1.9-0.3,2.7c-0.1,0.4-0.6,0.7-0.9,1c-0.2-0.3-0.7-0.7-0.7-1C83.3,140.8,83.5,139.8,83.8,138.7z M79,141.3 c0.3,0.2,0.7,0.4,1,0.7c0.4,0.4,0.6,0.9,1,1.2c0.5,0.4,1.1,0.8,0.4,1.4c-0.6,0.6-1.4,0.7-1.9,0c-0.5-0.6-0.7-1.4-1.1-2.2 C78.6,142,78.8,141.6,79,141.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M94.5,173.7c0.1,1.7,0.2,3.4,0.3,5.6c1.5-1.1,2.7-1.9,3.8-2.8c0.2-0.1,0.2-0.6,0.2-0.9 C98.3,174.4,95.8,173.3,94.5,173.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M105,183.5c-0.3-0.7-0.3-1.7-1.2-1.5c-0.9,0.2-2.1-0.4-2.6,1.2c-0.6,2.1-2.1,3.6-4.4,3.9 c-0.7,0.1-1.3,0.3-1.9,0.5c-0.1,1.5-0.2,2.9-0.2,4.3c0,0.1,0,0.2,0.1,0.4c0.3,1,1.9,2.8,2.9,3.3c0.1,0,0.2,0.1,0.3,0.1 c0.8,0.1,1.7,0.4,2.5,0.4c1.5,0,3-0.2,4.5-0.2c0.8,0,1-0.4,1-1.1C105.9,190.9,106.5,187.1,105,183.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M81.2,194.6c-0.5,0.1-1.4,0-1.1,0.8c0.2,0.8,0.8,1.5,1.3,2.3c0.3-0.3,0.6-0.5,0.8-0.8c0.1-0.2,0-0.6,0-0.9 C82,195.5,82.5,194.4,81.2,194.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M90.5,198c1.1,2.2,2.4,4.2,4.2,5.8c1.6,1.4,3.5,1.6,5.5,1.3c0.8-0.1,1.7-0.4,2.3-0.9 c1.6-1.6,2.9-3.5,3.3-6.2c-0.7,0-1.3,0-2,0c-2.6,0-5.1,0.6-7.7-0.4c-1.8-0.7-3.9-0.5-6.1-0.8C90.4,197.4,90.4,197.7,90.5,198z  M95.5,199.5c1.3,0.5,2.6,0.8,4.3,0.8c0.8,0,1.5,0,2.2-0.1c0.4,0,0.8-0.1,1.3-0.1c-0.5,1-1.1,1.9-2,2.7c-0.1,0.1-0.4,0.2-1.2,0.4 c-1.7,0.3-2.9,0-3.9-0.9c-1-0.9-1.9-2-2.7-3.3C94.2,199.2,94.9,199.3,95.5,199.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M82.5,161.5c0.4,0.2,0.9,0.4,1.3,0.6c0.1-0.2,0.2-0.4,0.3-0.5c-0.4-0.3-0.9-0.6-1.3-0.8 C82.7,161,82.4,161.5,82.5,161.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M85.5,154.7c-0.1-2.3-1.7-4-2.6-6.2c-0.7,1.6-1.4,2.7-1.8,4c-0.4,0.9-0.7,2-0.7,3c0,0.8,0.4,1.7,0.7,2.6 c0.2,0.6,0.5,0.8,1.2,0.9c1.5,0,1.9-1.3,2.6-2.1C85.2,156.3,85.5,155.4,85.5,154.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M66.4,152.6c-0.5,2.3,0.1,4.4,1.2,6.4C68.2,156.6,66.5,154.7,66.4,152.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M70,142.8c-0.1,0-0.2-0.1-0.3-0.1c-1.8,1.6-3.6,6.4-2.9,7.8C67.9,147.9,68.9,145.3,70,142.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M70.3,154c-0.4-2.3,1.1-4.5,0.5-7.1C69.7,148.4,69.5,152.9,70.3,154z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M287.9,103c0.2-0.4,0.3-0.8,0.4-1.2c-0.3-0.1-0.4-0.2-0.4-0.1c-2.5,0.5-4.9,0.6-7.5-0.2 c-1.2-0.4-2.5,0.2-3.1,1.3c-0.3,0.5,0.1,1.5,0.2,2.2c0,0.2,0.2,0.4,0.2,0.4c0.9,0.3,1.4,0.4,2,0.6c0.4,0.1,0.7,0.4,1.1,0.4 C283.5,106.2,286.2,105.7,287.9,103z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M273.2,90.3c1.3,0.5,2.6,1,3.7,1.7c0.6,0.4,1.1,0.6,1.9,0.4c1.6-0.3,3.3-0.7,4.9-0.8 c1.9-0.1,3.8,0,5.7-0.1c0.8,0,1.6-0.3,2.4-0.4c0.8-0.1,1.7-0.2,2.5-0.2c1.3,0,2.6,0,3.9,0c0-0.2,0.1-0.3,0.1-0.5 c-0.4-0.3-0.8-0.7-1.2-0.8c-3-1.1-6.1-2.1-9.1-3.2c-0.5-0.2-1.1-0.3-1.6-0.5c-1.9-0.6-3.8-0.4-5.7-0.3c-3.2,0-6.3,0.1-9.4,1.2 c-0.9,0.3-2,0.3-3.1,0.3c-0.7,0-1.4,0-2.1,0c0,0.1,0,0.2,0,0.4c0.2,0.2,0.4,0.4,0.7,0.5C269,88.7,271.1,89.4,273.2,90.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M58,157.7c-2.2,0.3-3.7,1.5-5.1,3.5c0.8,0.2,1.4,0.4,2,0.5c1,0.2,2,0.4,2.9,0.4c0.7,0,1.6-0.2,1.9-0.7 c0.3-0.6,0.3-1.6,0.1-2.3C59.5,158.3,59,157.6,58,157.7z M57.6,160c-0.2,0-0.4,0-0.5,0c0.3-0.1,0.5-0.2,0.8-0.2c0,0.1,0,0.2,0,0.3 C57.8,160,57.7,160,57.6,160z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M290.2,93.9c-0.6,0.1-0.7,0.3-0.7,1c-0.1,0.9-0.3,1.8-0.6,2.7c-0.3,0.7-0.8,1.4-1.7,1 c-0.8-0.4-0.9-1.2-0.6-2c0.2-0.7,0.6-1.4,1.1-2.6c-1.1,0-2-0.1-2.9,0c-1.6,0.1-3.2,0.2-4.8,0.5c-1,0.2-2.2,0.6-2.9,1.3 c-1.1,1.1-2,2.5-2.7,3.8c-0.5,0.8-0.6,1.9-0.9,2.8c1.4-0.3,2.7-0.2,3.4-1.6c0.1-0.3,0.5-0.5,0.8-0.7c1.1-0.8,2.3-1,3.7-0.6 c2.3,0.5,4.6,0.7,6.9,0c0.7-0.2,1.7-0.4,1.7,0.8c0,2.9-0.9,5-3.7,6.6c-1.4,0.8-3,1.3-4.8,2c1.2,0.7,2.1,1.4,3.1,1.8 c2,0.8,4.1,1.4,6.2,2c0.2,0.1,0.6,0,0.8-0.1c0.6-0.2,1.2-0.5,2.1-0.9c1.6-2.7,3.4-5.8,5.2-8.9c1.7-3.1,3.4-6.2,5.2-9.5 c-1.5,0-2.7,0.1-3.8,0C296.9,93.1,293.5,93.2,290.2,93.9z M293.9,105.8c-0.1,0.1-0.3,0-0.5,0c0,0,0,0.1,0,0.1 c-0.5-0.1-1-0.1-1.4-0.3c-0.4-0.3-0.6-0.8-0.7-1.3c0-0.1,0.6-0.5,1-0.6c0.5-0.1,1.1-0.1,1.7,0.1c0.4,0.2,0.8,0.6,1.2,0.9 C294.8,105.1,294.3,105.5,293.9,105.8z M296.3,99.7c-1.2,0.6-2.4,1.1-3.7,1.4c-0.8,0.2-1.4-0.9-1-1.8c0.3-0.6,0.7-1.2,1.2-1.7 c0.8-0.7,1.4-0.5,1.9,0.6c0.3-0.1,0.5-0.3,0.7-0.3c0.5,0.1,1.2,0.1,1.4,0.4C296.9,98.6,296.6,99.5,296.3,99.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M257.2,92.7c2,0.6,2.9,1.7,2.9,3.8c0,1.5,0.3,1.8,1.9,1.8c0.6,0,1.3,0.1,1.9,0.4c0.8,0.5,1.5,1.2,2.2,1.7 c1.1,0.7,2.2,1.3,3.3,2c0.7,0.4,1.1,0.3,1.5-0.4c0.4-0.8,0.7-1.6,1.1-2.3c1.1-1.8,2.3-3.6,3.4-5.3c0.4-0.6,0.5-1.1-0.3-1.4 c-2.3-0.8-4.6-1.7-7-2.4c-2.1-0.6-4.1-1.7-6.4-1.4c-1.4,0.2-2.6-1.2-4.2-0.6c-0.8,0.3-3,2.2-2.6,2.6 C255.4,92,256.3,92.5,257.2,92.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M214.6,112.7c0.7,0.4,1.4,0.8,2.2,0.9c4,0.5,7.4,2.7,11.1,3.9c1.7,0.5,3.3,1.4,5.2,2.2 c0.1-0.9,0.2-1.4,0.1-1.9c-0.1-2.2-0.2-4.3-0.3-6.5c-0.1-4.3-0.2-8.6-0.3-13c0-0.3-0.3-0.8-0.6-0.9c-1.3-0.4-2.6-0.7-3.9-1.1 c-2.8-0.7-5.7-1.5-8.5-2.2c-0.5-0.1-0.9-0.4-1.3-0.5c-1.5-0.5-3-1-4.6-1.5c-0.1,0.4-0.1,0.5-0.1,0.7c0.1,6.2,0.1,12.3,0.3,18.5 C213.9,111.9,214.2,112.5,214.6,112.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M124.8,112.4c-0.1,0-0.2,0-0.4,0c-1.8-0.3-3.6-0.7-5.6-1.1c-0.6,1.9-0.2,2.8,1.7,3.5 c1.3,0.4,2.6,0.8,3.9,0.9c1.9,0.2,3.8,0.1,5.7,0.2c0.5,0,1,0.2,1.5,0.2c1.8-0.1,3.6-0.3,5.4-0.3c1.3,0,2.6,0.4,3.9,0 c0.8-0.2,1.6-0.3,2.4-0.3c0.8,0,1.6,0.1,2.4,0.2c1.1,0.1,2.1,0.2,3.2,0.5c1.5,0.3,2.9,0.7,4.4,1.1c0.3,0.1,0.5,0.1,0.8,0.1 c0-1.4-0.7-2.3-2.5-2.6c-2.8-0.3-5.2-2.1-8.2-2.1c-2.4,0-4.7-1-7.1,0.1c-0.3,0.1-0.8,0.2-1,0c-0.8-0.4-1.5-0.4-2.4-0.5 C130.1,112.4,127.5,111.5,124.8,112.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M197.7,130.8c0.5,1,1.4,1.8,2.1,2.7c0.3,0.4,0.7,0.7,0.9,1.1c0.5,0.8,0.9,1.7,1.3,2.5 c0.1,0,0.3-0.1,0.4-0.1c0.4-1.6,1.3-3,0.7-4.8c-0.6-2-2-3.1-3.6-4.1c-0.2-0.1-0.6-0.1-0.9,0C197.5,128.8,197.1,129.7,197.7,130.8z "}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M298.5,119.1c1.4,0.3,2.9,0.6,4.3,0.7c1,0.1,1.9-0.3,2.9-0.5c0.9,0.3,1.5-0.5,1-1.2 c-0.6-0.8-1.3-1.5-2.1-2c-1.6-1-3.2-0.2-4.9,0.1c-1,0.2-1.7,1.3-1.6,2.4C298.1,118.7,298.3,119.1,298.5,119.1z M303.4,117.7 c-0.2,0-0.4,0-0.5,0c-0.3,0-0.6,0-0.9-0.1C302.6,117.6,303.1,117.5,303.4,117.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M296.2,118.3c0.2-0.5,0.2-1,0.2-1.5c-0.2,0-0.3-0.1-0.5-0.1c-0.2,0.5-0.5,1.1-0.7,1.6 C295.5,118.3,296.1,118.4,296.2,118.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M212.1,115.9c0-0.3-0.2-0.7-0.5-0.8c-0.3-0.1-0.7,0-0.9,0.2c-1.2,1-0.9,1.9,1.4,2.9 C212.1,117.3,212.2,116.6,212.1,115.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M193.6,123.4c-0.7,0.8-0.8,1.7-0.6,2.7c1.8-0.4,3.7-2.8,3.7-4.2c0.2-2.7,0-5.3-2-7.3 c-0.3-0.3-0.8-0.5-1.3-0.8c-0.3,0.5-0.7,0.9-0.8,1.4c-0.3,1.2,0.4,2.2,1.1,3.1C195,120,195,121.9,193.6,123.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M197.1,127.6c0.3-0.5,0.6-1.1,0.9-1.6c-0.2-0.1-0.3-0.2-0.5-0.3c-0.3,0.5-0.7,1-1,1.5 C196.8,127.3,196.9,127.5,197.1,127.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M222.1,91.4c1.6,0.6,3.2,1.2,4.8,1.8c0.8,0.3,1.6,0.5,2.4,0.8c0.6,0.2,1.2,0.4,1.8,0.7 c2.3,1,4.5-0.2,6.7-0.4c3.6-0.2,7.2-1.1,10.8-0.9c0.7,0,1.5-0.3,2.2-0.5c0-0.1,0.1-0.3,0.1-0.4c-0.5-0.3-1.1-0.8-1.6-1 c-1.4-0.5-2.8-0.9-4.3-1.2c-2.8-0.6-5.6-1.3-8.5-1.7c-1.4-0.2-2.8,0.2-4.2,0.4c-1.6,0.2-3.2,0.7-4.8,0.7c-2,0.1-4,0.3-5.9,1.2 C221.8,91.2,221.9,91.3,222.1,91.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M194.6,162.4c-0.1,1.1,0.3,1.6,1.4,1.4c0.3,0,0.6,0,0.8-0.1c3.5-0.7,7-0.9,10.5-0.4 c0.9,0.1,1.7-0.1,2.6-0.1c1.4-0.1,2.8-0.3,4.3-0.3c1.6,0,3.1-0.2,4.9-1.2c-0.6-0.1-0.9-0.1-1.2-0.2c-0.3,0-0.6,0-0.9-0.1 c-1.9-0.6-3.8-1.2-5.7-1.8c-1.2-0.4-2.4-0.9-3.7-1.4c-0.5-0.2-1-0.5-1.6-0.5c-2-0.1-4-0.3-6-0.2c-1.6,0.1-3.1,0.7-4.7,0.9 c-0.7,0.1-1,0.5-1,1.3C194.5,160.6,194.6,161.5,194.6,162.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M148.7,99.4c1.7,0.4,3.4,0.9,5.2,1.4c1.9,0.6,3.9,1.2,5.8,1.8c1.1,0.3,2.4,0.3,3.3,0.8 c1.6,1.1,3.5,1.5,4.9,2.8c1.3,1.2,2.9,2,4.3,3c1.7,1.2,2.9,2.6,3.5,4.7c0.7,2.2,1.8,4.2,2.7,6.3c0.1,0,0.3-0.1,0.4-0.1 c-0.3-1.4-0.6-2.8-0.9-4.2c-0.3-1.3-0.6-2.7-1.1-4c-0.7-1.8-1.6-3.6-2.6-5.3c-0.3-0.5-1.3-0.5-2-0.8c-0.4-0.2-0.8-0.3-1.2-0.6 c-0.4-0.3-0.8-0.8-1.2-1.1c-1.7-1-3.4-1.9-5.2-2.8c-0.4-0.2-0.8-0.5-1.2-0.4c-1.3,0.2-2.4-0.3-3.5-0.9c-1.1-0.6-2.2-1-3.5-0.8 c-0.3,0-0.7-0.1-1-0.2c-1.4-0.5-2.7-1-4.1-1.5c-0.2-0.1-0.4-0.1-0.6-0.1c-1.3-0.1-2.7-0.3-4-0.4C146.4,98.3,147,99,148.7,99.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M167.2,151c0-1.3,0-2.6,0-3.9c-0.3-5.5-0.6-10.9-0.8-16.4c-0.1-1.9,0-3.8-0.1-5.6c0-1-0.5-1.3-1.4-1 c-0.4,0.2-1,0.5-1.3,0.4c-0.8-0.3-1.1,0.1-1.1,0.8c-0.2,1.8-1.2,3.1-2.3,4.3c-0.2,0.3-0.5,0.5-0.7,0.9c-1,2.2-1.9,4.4-2.9,6.5 c-1,2.3-2.1,4.5-4,6.1c-1.1,1-1,1.6,0.1,2.7c1.6,1.6,3.2,3.2,4.3,5.3c2.7,5.8,3.5,11.9,4,18.2c0.1,0.7-0.1,1.9,0.3,2.2 c1.6,1.1,3.3,2,5.1,2.9c0.2,0.1,0.9-0.3,0.9-0.5c0.1-1.2,0.1-2.5,0.1-3.7c0-0.7,0-1.4,0-2.1c0-3.5,0.1-7,0.1-10.5 C167.5,155.3,167.3,153.2,167.2,151z M164.9,129.9c-0.3-0.5-0.7-0.9-0.9-1.4c-0.1-0.2,0.7-0.8,0.8-0.8c0.4,0.2,0.7,0.6,1.3,1.2 C165.5,129.4,165.2,129.6,164.9,129.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M167.8,120.4c0,0.2,0.2,0.4,0.4,0.5c1.2,0.8,3.5-0.4,3.3-1.8c-0.1-1.4-0.6-2.7-0.9-4.2 C167.9,116,167.1,117.9,167.8,120.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M136.8,108.8c-0.1,0.8,0.3,1,1,1.1c3.1,0.3,6.2,0.7,9.3,1c0.5,0,1-0.1,1.6-0.2c-0.3-0.3-0.4-0.5-0.5-0.7 c-1.8-2.1-4-3.4-6.5-4.3c-1.3-0.5-2.5-0.4-3.6,0c-0.8-0.5-1.4-0.9-2.1-1.3c-0.1,0-0.5,0.3-0.6,0.6c0,0.3,0.1,0.7,0.3,0.9 C137,106.7,136.9,107.7,136.8,108.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M148,106.1c0.9,0.5,1.8,1.3,2.4,2.2c1.1,1.5,2.9,2.4,3.4,4.4c0,0.2,0.4,0.3,0.6,0.4 c2.1,0.6,3.6,2.2,5.1,3.8c1.3,1.4,2.5,3,3.8,4.7c0.2-0.3,0.5-0.6,0.6-0.9c0.6-1.4,1.1-2.8,1.6-4.2c0.4-1,0.3-1.9,0.1-3 c-0.3-1.4-0.6-2.9-0.3-4.2c0.2-1.4-0.3-1.8-1.4-2.1c-1.5-0.4-2.9-1.1-4-2.3c-0.3-0.3-0.7-0.5-1.1-0.6c-1.4-0.4-2.9-0.8-4.3-1.1 c-2.1-0.6-4.2-1.2-6.3-1.7c-0.4-0.1-0.8-0.1-1.4-0.1c0,1,0,1.9,0,2.8C146.6,105,147,105.6,148,106.1z M163,115.5 c0.4,0.1,1,0.8,0.9,1.1c-0.1,0.7-0.1,1.7-1.2,1.7c-0.9,0-1.4-0.5-1.4-1.4C161.3,116.1,162.3,115.2,163,115.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M170,110.4c-0.1-1.3-1.3-1.2-2.4-1.7c0,1.5,0,2.8,0,4.4C168.7,112.2,170.1,111.9,170,110.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M175.4,101.7c-1-0.2-2.1,0.1-3.1,0.1c0,0.1-0.1,0.3-0.1,0.4c0.4,0.3,0.9,0.5,1.3,0.8 c0.9,0.5,1.9,0.9,2.5,1.7c0.9,1,1.6,2.3,2.3,3.5c0.6,1,1.3,1.9,0.5,3.1c-0.2,0.3,0,0.9,0.1,1.3c0.6,1.7,1.2,3.4,2,5.1 c0.6,1.3,1.3,2.6,2.2,3.5c1.4,1.4,3.4,1.6,5.3,1.8c1.6,0.1,2-0.3,2-2c0-0.7-0.1-1.3-0.2-2c-0.2-2.1-0.5-4.1-0.5-6.2 c-0.1-2.9-0.1-5.9-0.1-8.8c0-1.2-0.2-2.3-0.4-3.8c-2.4,0.4-4.8,0.7-7.1,1C179.9,101.5,177.7,102.2,175.4,101.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M189.6,125.1c-0.4,0.1-0.9,0-1.3,0c-1.4-0.3-2.8-0.5-4.2-0.9c-0.7-0.2-1.6-0.2-2.2-0.6 c-1-0.7-1.9-1.7-3.1-2.8c-0.1,0.9-0.3,1.4-0.1,1.8c0.5,1.3,1,2.6,1.8,3.7c0.5,0.8,1.4,1.4,2.6,1.3c0.9-0.1,1.9,0,2.8,0.1 c1.3,0.1,2.7,0.8,3.7-0.8c0.1-0.2,0.6-0.2,0.9-0.3c0.4-0.1,0.8-0.2,1.3-0.3C191.3,125.3,190.7,124.7,189.6,125.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M164.9,98.8c0.3,0.2,0.5,0.5,0.8,0.7c1.3,0.9,2.7,0.7,4.2,0.5c1.5-0.2,2.9-0.6,4.4-0.5 c3.4,0.2,6.6-0.3,9.8-0.9c0-0.1,0-0.2,0-0.4c-1.4-0.6-2.8-1.2-4.2-1.8c-1-0.4-1.9-0.9-2.9-1.2c-1.7-0.5-3.4-1-5-1.4 c-0.9-0.3-1.7,0-2.2,0.9c-0.1,0.3-0.3,0.6-0.5,0.8c-1.1,0.8-2.2,1.6-3.4,2.4C165.4,98.2,165.2,98.5,164.9,98.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M158.5,95.2c0.1-0.1-0.1-0.6-0.2-0.7c-0.7-0.5-2.9,0.1-3.6,1.1c1,0.3,1.9,0.7,2.8,0.8 C157.8,96.3,158.2,95.6,158.5,95.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M161.4,94.3c0.2,0.6,1.5,1.1,2.2,0.9c0.3-0.1,0.7-0.1,0.9,0c1,0.7,1.8,0.3,2.5-0.5 c1.4-1.6,1.5-3.5,0.7-5.4c-0.1,0-0.2,0-0.3,0c-1.7,0.6-3.3,1.2-5,1.8c-0.8,0.3-1.4,0.8-0.9,1.7C161.4,93.3,161.2,93.9,161.4,94.3z  M163.4,92.9C163.4,92.9,163.4,92.9,163.4,92.9c0.9-0.4,1.8-0.7,2.8-1.1c0,0.5-0.2,0.9-0.5,1.2l-1.2,0.1c-0.2,0-0.3-0.1-0.5-0.1 c-0.2,0-0.4,0-0.6,0.1C163.4,93.1,163.4,93,163.4,92.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M160.8,122.3c-1-2.3-3-3.4-4.5-5.1c-0.1,0.1-0.2,0.2-0.3,0.3c1.3,2.8,2.6,5.6,4.1,8.8 C160.1,124.7,161.5,123.9,160.8,122.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M244.4,197c1.1,0.5,2.1,1.2,3.2-0.2C246.4,196.4,245.4,196.1,244.4,197z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M246,200.5c-1.3,0-2.2,0.1-3,1.4c-1.3,2.1-1.7,5.1,0.4,7.2c2.9-1.5,4-4.1,4-7.2 C247.5,201.3,247,200.6,246,200.5z M244,206.3c-0.2-1.1,0.1-2.3,0.7-3.2c0.2-0.4,0.3-0.5,0.7-0.5 C245.3,204.2,244.8,205.4,244,206.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M243.1,183.3c0,0-0.1,0-0.1,0c0,0.1,0,0.2,0,0.4c0.1,0.7,0,1.5,1.2,1.4c1-0.1,1-0.7,1-1.4 c0-1.3,0-2.6,0-3.9c0-2.9,0-5.8,0.2-8.7c0.1-1.7,0.3-3.4,0.7-5.1c0.6-2.3,1.5-4.5,2.2-6.8c0.6-1.7,0.4-1.8-1.2-2.4 c-0.9-0.3-1.2,0.3-1.4,0.9c-0.5,1.4-0.7,2.9-1.3,4.3c-1.7,3.7-1.7,7.7-2.2,11.6c-0.2,1.6,0.1,3.2,0.3,4.8 C242.6,180,242.9,181.6,243.1,183.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M252.9,187.8c-0.2,0.6-0.6,1.1-1,1.5c-1.1,1.1-2.5,1.3-4,1.4c-1.9,0.1-3-1.4-2.6-3.3 c0.1-0.3-0.3-1-0.5-1.1c-1.4-0.3-2,0.4-1.8,1.9c0,0.3,0,0.7,0.1,1c0.2,1.6,0.3,1.7,1.8,1.6c0,0.2,0.1,0.4,0.1,0.7 c0,1.8,0.4,2.2,2.2,2.5c0.7,0.1,1.5,0.6,2.1,1c0.7,0.5,1.3,0.6,1.9,0c2.7-2.6,5.4-5.3,5.3-9.6 C254.5,185.3,253.6,185.9,252.9,187.8z M250.3,193.2c-0.3-0.2-0.6-0.4-1-0.6c0.7-0.1,1.4-0.3,2.1-0.6 C251.1,192.4,250.8,192.8,250.3,193.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M259.9,176.2c-0.1-1.9-0.1-3.9-0.2-5.8c0-0.9-0.2-1.8-0.3-2.6c0.3-2.6,0.1-2.8-2.4-3.7 c-0.4-0.1-0.6-0.5-0.9-0.7c-1.4-1.1-2.9-2.2-4.4-3.2c-0.2-0.2-0.9-0.1-1,0.1c-0.8,1.6-1.8,3.1-2.2,4.8c-0.9,3.8-2,7.6-1.7,11.7 c0.2,2.2,0.2,4.4,0.2,6.6c0,1.1,0.5,1.3,1.4,1.2c3.8-0.6,7.5-1.1,11.3-1.7c0.3,0,0.7-0.3,0.7-0.4c0.1-0.8,0-1.7,0-2.5 C260.3,178.7,260,177.5,259.9,176.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M233.3,171c0-0.4-0.2-0.9-0.5-1.3c-0.9-1.5-2.4-2.5-2.6-4.4c-0.2-1.6-0.4-3.2-0.6-4.8 c-0.1-0.6-0.1-1.3,0-2c0.2-0.7,0.5-1.4,1.4-0.7c0.5,0.4,0.9,0.8,1.4,1.1c0.4,0.2,0.9,0.5,1.3,0.4c0.3-0.1,0.6-0.7,0.6-1.1 c0-1.8-0.1-3.5-0.2-5.3c-0.1-2.4-0.3-4.9-0.5-7.3c-0.1-2-0.2-4-0.2-5.9c0-1.4,0-2.7,0-4.1c0-1.4-0.1-2.9-1.7-3.4 c-0.8-0.2-1.7,0.2-2.6,0.4c-0.6,0.2-1.2,0.4-2.2,0.8c0,0.1-0.1,0.6-0.3,1.1c-0.6,1.5-1.3,3.2-2.9,3.7c-1.9,0.6-3.5,2-5.7,1.7 c-0.7-0.1-1.5,0-2.2,0c-1.4,0-1.9-0.8-1.3-2.2c0.3-0.7,0.5-1.4,0.8-2c0.5-1.2,0.8-2.5,1.5-3.5c0.9-1.3,2.1-2.5,3.2-3.6 c0.9-1,1.9-1.8,3.1-2.9c-0.6-0.5-1-0.9-1.4-1.1c-2.2-1-4.5-2-6.8-3c-0.9-0.4-1.8,0.1-1.8,1c-0.1,2.4,0,4.9-0.1,7.3 c0,0.9,0.4,1.3,1.2,1.3c0.8,0,0.9,0.5,0.9,1.1c0,0.7-0.3,0.9-1,0.9c-0.5,0-1.1,0.1-1,0.9c0.1,2.2,0.2,4.4,0.3,6.6 c0,0.3,0.3,0.6,0.5,0.7c1.5,0.8,1.5,1.1,0.5,2.4c-0.7,0.9-1.1,1.7-1,2.9c0.1,3.1,0.2,6.1,0.3,9.2c0,1.9,0.1,2,1.9,2.5 c2.3,0.7,4.6,1.7,6.9,2.3c1.5,0.4,2.7,1.6,4.4,1c0.1,0,0.4,0.3,0.5,0.4c0.3,1.3,0.6,2.6,0.7,3.9c0.1,1.9,0,3.9,0,5.8 c0,1.8,0.2,3.5,0.2,5.3c0,1.5,0,2.9,0.1,4.4c0,0.3,0.5,0.8,0.8,0.9c1.3,0.5,2.7,0.8,4,1.2c0-0.1,0.1-0.4,0.1-0.6 c0-2.7-0.1-5.4-0.2-8.1C233.3,173.7,233.4,172.3,233.3,171z M220.1,144.3c0,0.3,0.1,0.7,0,1c-0.1,0.4-0.3,0.7-0.5,1.1 c-0.3-0.3-0.8-0.5-0.8-0.9c-0.2-0.8-0.4-1.7-0.4-2.6c0-0.3,0.6-0.6,0.9-0.9c0.3,0.3,0.6,0.6,0.8,1 C220.2,143.4,220.1,143.8,220.1,144.3C220.1,144.3,220.1,144.3,220.1,144.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M243.6,153.9c-0.6-0.5-1.3-1-1.7-1.6c-1.6-2.3-3.5-4.4-4.6-7.1c-0.3-0.8-1-1.5-1.6-2.2 c0.1,2.9,0.2,5.7,0.3,8.5c0,2.3,0,4.7,0,7c0,1.6,0.4,3.1,2.1,3.8c1,0.5,1.8,1.1,2,2.4c0,0.3,0.3,0.5,0.5,0.8 c0.5-0.9,0.9-1.7,1.3-2.5c0.8-2.2,1.6-4.4,2.3-6.6C244.6,155.4,244.4,154.6,243.6,153.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M229.2,130.1c0.2-0.1,0.3-0.7,0.2-0.9c-0.5-0.6-1.1-1.1-1.7-1.7c-0.1,0.1-0.3,0.2-0.4,0.3 c0.3,0.8,0.6,1.6,1,2.3C228.3,130.3,229,130.3,229.2,130.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M217.9,136c-0.1,0.3,0.1,0.9,0.4,1.1c1,0.7,2.2,0.4,3-0.5c0.5-0.5,1-1,1.6-1.4c1.2-0.9,2-2,2-3.6 c0-0.1,0-0.2,0-0.4c-0.1-0.4-0.2-0.8-0.3-1.2c-0.2-1.3-0.4-1.3-1.6-0.8C220.2,130.6,219.1,133.4,217.9,136z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M290.2,139.7c0.8-0.9,2.3-1.9,2.4-3c0.3-1.9-0.4-3.8-1.9-5.7c-0.8-1-1.8-1.6-2.9-1.6c-0.2,0-0.5,0-0.7,0.1 c0.5-0.8,1-1.6,1.5-2.4c0.5-0.7,0.9-1.4,1.4-2.2c0.2-0.4,0.4-0.7,0.5-1.1c0-0.1,0.1-0.2,0.1-0.3c0.3-0.2,0.6-0.4,0.9-0.6 c0.5-0.3,1.1-0.7,1.4-0.7c0.1,0,0.3,0.1,0.5,0.2c0.7,0.5,1.5,0.5,2.1,0.5c0.1,0,0.2,0,0.3,0c0.1,0,0.1,0,0.2,0 c1.1,0.9,2.4,1,3.2,1.1c0.3,0,0.7,0,0.9,0.1c1.2,0.6,2.5,0.6,3.6,0.7c0.2,0,0.4,0,0.6,0l0.5,0c0.4,0,0.8,0.1,1.3,0.1 c0.9,0,1.6-0.1,2.3-0.4c1.2-0.5,2.2-1.2,3-1.9c0.2-0.2,0.4-0.3,0.7-0.5c1.1-0.8,1.7-1.8,1.7-2.9c0-1-0.4-1.9-1.2-2.7l-0.3-0.3 c-1.5-1.3-3-2.6-4.7-3.7l-0.4-0.3c-1.1-0.7-2.5-1.6-4.2-1.6c-0.4,0-0.8,0-1.2,0.1c-1.1,0.3-2.2,0.6-3.3,1c0.6-1,1.2-2,1.8-3 c1.1-1.8,2.3-3.7,3.4-5.5l0.5-0.9c1.4-2.3,2.8-4.7,4.1-7.2c0.4-0.8,0.6-1.6,0.7-2.4l0.2-0.3c0.3-0.5,0.3-0.9,0-1.3 c0-0.2,0-0.4,0.1-0.6c0.1-0.5,0-1.1-0.3-1.5c-0.3-0.4-0.8-0.7-1.3-0.8c-0.8-0.1-1.2-0.3-1.7-0.4L305,88c-0.8-0.3-1.6-0.6-2.5-0.9 c-1.3-0.5-2.6-1-3.8-1.5c-0.8-0.3-1.5-0.6-2.3-0.9c-1.3-0.5-2.6-1-3.8-1.5c-0.4-0.2-0.8-0.2-1.1-0.3c0,0-0.1,0-0.1,0 c-2-1.4-4.6-2.1-7.6-2.2c-2.2-0.1-4.4,0.3-6.4,0.7c-0.7,0.1-1.3,0.2-2,0.3c-1,0.2-2.1,0.4-3.1,0.5c-1.1,0.2-2.1,0.4-3.2,0.6 c-1.5,0.2-3.1,0.3-4.4,0.4c-0.5,0-0.9,0-1.4,0.1c-1.8,0.1-3.5,0.2-5.1,0.1c-2.2-0.2-3.9,0.6-5.1,2.2c-0.3,0.5-0.7,0.9-1,1.4 l-0.6,0.7c-0.3,0.4-0.4,0.5-0.5,0.6c-0.1,0-0.3-0.1-0.8-0.2c-0.5-0.2-1.1-0.4-1.6-0.6c-1.1-0.4-2.3-0.9-3.5-1.3l-0.3-0.1 c-2.4-0.7-4.9-1.5-7.4-1.9c-1.8-0.3-3.9-0.1-5.5,0.5c-1.4,0.5-2.8,0.6-4.4,0.6l-0.4,0c-0.7,0-1.3,0-2,0c-1.1,0-2.2,0-3.3,0.1 c-1.9,0.1-3.8,0.3-5.7,0.5l-1.9,0.2c-0.4,0-0.7,0.1-1,0.2c-3,0.9-4.7,4.1-4.1,7.4c0.1,0.4,0.2,0.7,0.2,1.1 c0.3,1.3,0.5,2.1,0.2,2.9c-0.3,0.7-0.6,1.7-0.2,2.7c0.8,2.3,0.7,4.8,0.4,7.6c-0.2,2.2-0.4,3.1-1.6,3.7c-1.2,0.6-1.9,1.8-2.1,3.4 c-0.2,1.8,0.2,4.1,1.7,5.3l0.3,0.2c0.6,0.5,0.7,0.6,0.7,0.7c0.1,1.4,0.2,2.8,0.4,4.2c0.1,1.4,0.3,2.9,0.4,4.3 c-0.7,0.5-1,1.1-1.1,1.5c-0.3,1.3,0.4,2.3,0.7,2.7c0.2,0.3,0.4,0.5,0.6,0.7c0,0,0,0,0,0c0.1,0.7,0.1,1.5,0.2,2.2c0,0,0,0,0,0.1 c-0.4-0.6-0.9-1.3-1.4-1.9c-0.3-0.4-0.7-0.6-1.1-0.8c0.1-1.4,0-2.9-0.5-4.3c-0.8-2.4-2.5-4.4-4.7-5.4c-0.8-1.4-1.2-3-1.3-5.1 c-0.2-4.4-2.1-7.9-5.5-10.2c-0.1-0.1-0.2-0.1-0.2-0.2l-0.2-8.2c0-0.6-0.3-1-0.8-1.2c0,0,0,0,0,0c0,0,0,0,0,0l0,0 c-0.1-1.8-1.2-3-2.8-3.2c-0.2-0.1-0.3-0.2-0.5-0.3c-0.3-0.2-0.6-0.3-0.9-0.5c-0.9-0.4-1.7-0.9-2.7-1.3c-0.6-0.2-1.1-0.3-1.5-0.3 c-0.1,0-0.3,0-0.3,0c-0.7-0.3-1.3-0.6-2-0.9c-2-1-4.1-2-6.6-2.4c-0.5-0.1-1-0.3-1.5-0.5c0,0,0,0,0,0c0.2,0,0.4-0.1,0.6-0.2 l0.8-0.4c0.7-0.3,1.5-0.7,2.2-1.1c1-0.6,1.6-2.1,1.2-3.2c-0.4-1.2-1.7-1.6-2.6-1.7l-0.4,0c-0.6,0-1.1,0-1.7,0c-0.2,0-0.4,0-0.6,0 l0.2-0.2c0.3-0.3,0.5-0.6,0.7-0.9c0.1-0.1,0.1-0.2,0.2-0.4c0.3-0.5,0.4-1,0.3-1.6c-0.1-0.5-0.5-1-1-1.3c-0.1,0-0.1-0.1-0.1-0.1 c-0.3-0.2-0.9-0.6-1.6-0.6c-0.1,0-0.3,0-0.4,0c-2.8,0.5-4.2,2.1-4.8,3.4c0,0.1,0,0.1-0.1,0.2c0-0.5,0-0.9-0.1-1.4 c-0.2-1.3-1.3-2.2-2.6-2.2c-1.1,0-2.1,0.6-2.6,1.6c-0.3,0.6-0.5,1.3-0.7,1.9c-0.1,0.3-0.1,0.5-0.2,0.8c-0.2,0.7,0,1.4,0.4,1.9 c0.1,0.1,0.1,0.1,0.2,0.2c0.3,0.4,0.8,1.1,1.6,1.4c0,0,0,0,0,0c-0.5,0.2-0.9,0.3-1.4,0.4c-1.4,0.2-3.1,0.6-4.5,2.3 c-0.5,0.6-0.9,0.8-1.7,0.8c-2.2,0-4.2,0.4-6,1c-0.6,0.2-1.3,0.3-2.1,0.3c-0.7,0-1.3-0.1-1.9-0.2l-0.1,0c-0.7-0.1-1.3-0.1-1.9,0.2 c-1.6,0.7-2.8,1.9-3.3,3.5c-0.4,1.4-0.3,2.8,0.5,4.1c0.3,0.6,0.4,1.2,0.5,2.1c0,0,0,0.1,0,0.1c0,0,0,0-0.1,0 c-0.2-0.1-0.4-0.2-0.6-0.3c-0.2-0.1-0.4-0.2-0.6-0.3c-0.6-0.3-1.3-0.6-2.1-0.8c0-0.1,0-0.1,0-0.2c0.1-1.8,0-4.5-1.8-6.7 c1-0.4,2-1.1,2.6-1.7c1-1,1.5-2,1.5-3.1c0-0.1,0-0.1,0-0.2c-0.2-1.6-1.3-2.7-2.7-2.7c-0.5,0-1,0.2-1.5,0.5 c-1.3,0.8-2.3,1.8-3.5,2.8c-0.1,0.1-0.1,0.1-0.2,0.2c-0.1-0.1-0.3-0.1-0.4-0.2c1.4-0.3,2.1-1.8,2.2-2.7c0.1-0.7,0-1.3-0.1-1.8 c0.1-0.3,0.1-0.5,0.1-0.8c0-0.2,0-0.8-0.3-1.3c-0.2-0.4-0.5-0.7-0.7-1.1l-0.2-0.3c-0.3-0.5-0.9-0.8-1.5-0.9 c-0.6-0.1-1.2,0.2-1.6,0.6c-0.1,0.1-0.2,0.2-0.3,0.3c-0.3,0.3-0.6,0.6-0.9,1c-0.3,0.4-0.9,1.3-0.9,2.4c0,1.3,0.2,2.3,0.6,3.1 c0.4,0.8,1.1,1.3,1.9,1.5c-0.3,0.1-0.6,0.2-0.9,0.4c-0.4-0.6-0.8-1-1.2-1.4c-0.1-0.1-0.3-0.3-0.4-0.4c-0.4-0.4-1-0.7-1.7-0.7 c-0.3,0-1.2,0.1-1.8,0.7c-2,1.9-1.1,4.3-0.8,5.1c0.3,0.9,1,1.4,1.3,1.7c0.4,0.3,0.8,0.5,1.3,0.5l0.2,0c0.1,0,0.1,0,0.1,0 c0,0,0,0,0,0c-0.1,0.1-0.2,0.3-0.3,0.5c-0.2,0.3-0.5,0.7-0.7,1.3c-0.4-0.1-0.9-0.3-1.4-0.3c-2.4-0.4-4.3-0.9-5.9-2.1 c-0.5-0.4-1.1-0.5-1.4-0.6c-0.1,0-0.2,0-0.2-0.1c-0.7-0.3-1.4-0.4-2-0.4c-0.5,0-0.6-0.1-0.7-0.1c-2-2.1-4.5-3.8-7.6-5.3 c0-0.1-0.1-0.2-0.1-0.2c0-0.2,0-0.5,0.2-1.3c0.1-0.5,0.3-0.9,0.4-1.4c0.6-1.6,1.2-3.6,0.5-6c-0.1-0.4-0.2-0.9-0.3-1.4 c-0.2-0.8-0.4-1.8-0.8-2.7c-0.5-1-1-1.9-1.6-2.8c-0.3-0.4-0.6-0.8-0.8-1.3c-0.9-1.5-2.1-1.7-2.7-1.7c-0.5,0-1.2,0.1-2,0.8 c-0.8,0.7-1.4,1.5-1.9,2.2c-2.3,3.2-3.4,6.2-3.3,9.2c0,0.3,0,0.5,0,0.8c0,1.3-0.1,3.2,1.3,4.8c0,0,0,0,0,0c0,0.3,0.1,0.7,0.1,1 c-0.1,0.1-0.2,0.2-0.2,0.2c-2.5,1-4.4,2.7-6.2,4.3l-0.4,0.3c-0.1,0-0.4,0-0.5,0.1l-0.1,0c-0.1,0-0.2,0-0.3,0 c-0.3-0.1-0.9-0.2-1.4-0.1c-0.7,0.1-1.4,0.1-2,0.2c-2.6,0.2-5.4,0.5-8.1,1.9c-1.3,0.6-2.7,1-4.3,1.5c-0.4,0.1-0.7,0.2-1.1,0.3 c-2,0.6-3,2.1-3.2,4.6c-0.1,2.2-0.1,4.5-0.1,6.6l0,1.9c0,0.5,0,1.1,0,1.6c-0.1,1.5-0.1,3.1,0.2,4.7c0.2,0.9,0.1,1.9,0.1,3 c0,0.9-0.1,1.8,0,2.8c0.1,1.2,0,2.5,0,3.9c0,0.7-0.1,1.4-0.1,2.2c0,0.8,0,1.5,0,2.3c0,1.1,0,2.2-0.1,3.3c0,0.6-0.1,1.2-0.2,1.8 c-0.1,1-0.2,2-0.2,3.1c0,0.7,0,0.7-0.1,0.8c-3.2,3.9-5,8.8-5.4,15c0,0.1,0,0.1,0,0.2c-0.3,0.1-0.5,0.3-0.7,0.4 c-0.1,0.1-0.2,0.1-0.3,0.2c-1.7-1.2-3.5-1.4-5.2-0.5c-0.2,0.1-0.5,0.2-0.7,0.3c-0.9,0.4-1.9,0.9-2.7,1.9c0.1-0.6,0.1-1.2-0.2-1.7 c-0.9-1.7-2.3-3-4.3-4c-0.6-0.3-1.3-0.2-1.8,0.1c-0.6,0.3-0.9,0.9-1,1.6c-0.2,2.5,1.4,5.3,3.4,6.2c0.1,0,0.2,0.1,0.4,0.1 c-0.5,0.3-1,0.7-1.4,1.3c-0.4-0.4-0.8-0.7-1.4-1c-0.4-0.2-0.9-0.2-1.3-0.2c-1.8,0-2.8,1.3-3.4,2.1c-0.1,0.2-0.2,0.3-0.4,0.5 c-0.7,0.8-0.7,1.9,0,2.7c0.8,0.9,1.8,1.3,2.9,1.3c0.8,0,1.5-0.2,2.1-0.4l0.2-0.1c0.7-0.2,1.1-0.7,1.5-1c0,0,0.1-0.1,0.1-0.1 c0.2,0.3,0.4,0.6,0.7,0.8c0.4,0.3,0.8,0.6,1.2,0.9c-0.4,0.6-0.8,1.2-1.3,1.8l-0.6,0.8c-0.5,0.7-0.5,1.6,0,2.2 c0.1,0.2,0.2,0.4,0.3,0.5c0.3,0.6,0.7,1.2,1.4,1.7c0.4,0.2,0.8,0.4,1.2,0.4c1,0,2.4-0.7,2.9-1.7c0.5-1,0.9-2.1,1.2-3.3 c0.1-0.3,0.1-0.7,0-1c0.2,0,0.4,0.1,0.6,0.1c0.8,0.2,1.6,0.3,2.3,0.3c1.8,0,3.4-0.6,4.7-1.9c0.5-0.5,1-1.1,1.5-1.7l0.3,0.3 c1,1.1,2,2.3,3.2,3.3c0.3,0.3,0.5,0.4,0.4,1.4c-0.2,1.8-0.3,3.8-0.2,5.8c0.1,2,0.2,4,0.3,6c0.1,1.3,0.2,2.5,0.2,3.8 c0.1,2.7,0.8,6.4,4.1,8.5c-0.2,0.1-0.5,0.3-0.7,0.5c-1.6,1.3-3.2,2.6-4.7,3.9l-0.9,0.8c-1.1,1-1.2,2.1-1.2,2.6 c0.1,1,0.7,1.8,1.6,2.4c1.2,0.7,2.4,1.3,3.4,1.8c3.1,1.3,6.3,1.1,9.3-0.7c0.6-0.4,1.1-0.8,1.4-1.2c0.4-0.4,0.6-0.6,0.8-0.6 c0.6,2.8,1.8,6.2,5.1,8.6c0.1,0.1,0.2,0.2,0.4,0.3c0.1,0.1,0.3,0.2,0.4,0.3c0.1,1.2,1.2,1.9,1.5,2c0.8,0.4,1.6,0.8,2.3,1.2 c0.2,0.1,0.5,0.2,0.7,0.3c-0.3,1-0.2,2.1,0.4,3.1c0,0.1,0,0.2-0.1,0.3c-0.1,0.4-0.3,0.9-0.3,1.4l0,0.3c-0.3,2.5-0.6,5.6,2.1,8.1 c0.3,0.3,0.6,0.7,0.7,1.1c-0.9,0.2-1.9,0.9-2.4,1.9c-0.7,1.6-1.4,3.3-1.9,4.9c-0.3,0.9,0,1.7,0.2,2.2c0,0.1,0.1,0.2,0.1,0.3 c0.1,0.6,0.5,1,1,1.3c0.3,0.2,0.6,0.2,1,0.2c0.2,0,0.5,0,0.7-0.1c0.1,0,0.2-0.1,0.3-0.1c0.6-0.1,1.7-0.4,2.2-1.6 c0.1-0.2,0.1-0.3,0.2-0.5c-0.1,0.8-0.1,1.7,0.2,2.5c0.4,1.2,1.5,2,2.7,2c0.8,0,1.6-0.4,2.2-1c1.1-1.2,1.5-3.3,1.1-5.1 c0.5,0.4,1.2,0.8,2,0.8c0.1,0,0.3,0,0.4,0c1-0.2,1.9-0.9,2.7-2.1c0.9-1.3-0.2-2.5-0.6-3.1c-0.1-0.1-0.2-0.2-0.2-0.3 c-0.3-0.3-0.5-0.6-0.8-0.8c-0.1-0.1-0.2-0.1-0.3-0.2c-0.4-0.3-0.7-0.5-1.2-0.7c1.3-2.2,1.8-4.7,1.3-7.3c-0.3-1.6-0.8-3.8-2.1-5.5 c-0.3-0.4-0.5-0.8-0.6-1c0.2-0.1,0.4-0.2,0.6-0.3c2.8-1.5,6.6-3.4,8-8c0.4-1.3,1-2.6,1.7-3.9l0.4-0.9c0.1-0.1,0.3-0.3,0.4-0.4 c0.1-0.1,0.2-0.2,0.3-0.3c0,0,0.1-0.1,0.1-0.1c0.1-0.1,0.2-0.1,0.3-0.2c0,0,0.1,0.1,0.1,0.1c0.4,0.3,0.9,0.8,1.6,1.1l0.7,0.3 c1.4,0.7,2.9,1.3,4.5,1.6c1.5,0.3,3.3,0,4.9-0.7c0.3-0.1,0.6-0.3,0.8-0.4c0,0.2,0,0.5,0.1,0.7c0.1,0.2,0.1,0.4,0.2,0.5 c0.2,0.5,0.4,1.2,0.9,1.8c0.6,0.7,1.7,1.2,2.6,1.2c0.4,0,0.7-0.1,1-0.2c0.8-0.4,1.5-1.1,1.7-1.9c0.2-0.8,0.2-1.6-0.2-2.3 c0.9,0.5,1.8,0.8,2.5,0.9c0.1,0,0.3,0,0.4,0c1,0,2.7-0.7,3-2.1c0.3-1,0.2-2.8-1-3.7c-0.7-0.5-1.5-0.8-2.2-1.1 c-0.1,0-0.1,0-0.2-0.1c3,0,5.5-1,7.9-2.1l0.9-0.4c2.2-0.9,4.2-2.1,6.2-3.2c0.5-0.3,1-0.6,1.6-0.9c0.1,0,0.1-0.1,0.1-0.1 c0.7,0.6,1.6,0.8,2.2,0.9l0.3,0.1c0.6,0.1,1.1,0.2,1.6,0.3c0.2,0,0.5,0.1,0.7,0.1l0.3,0c0.7,0.1,1.4,0.3,2.1,0.4l0.3,0.1 c0.1,0,0.1,0,0.2,0c0.3,0.4,0.6,0.8,1,1.2c0.4,0.5,0.7,0.9,1.1,1.4c1,1.1,2,2.3,3.1,3.5c0.3,0.4,0.7,0.6,1,0.8 c0.1,0.1,0.2,0.1,0.3,0.2c1.5,2.1,3.6,3.5,5.6,4.7l0.1,0.1c0.9,0.5,2.1,1.2,3.6,1.2c0.5,0,1.1-0.1,1.6-0.3c0,0.1,0,0.3,0.1,0.5 c0,0.4,0.1,0.8,0.2,1.3c0.1,0.5,0.3,1,0.5,1.5c0.3,0.9,0.5,1.6,0.6,2.4c0.2,1.8,0.9,3.4,2.1,4.8c-0.8,0.2-1.8,0.8-2.1,1.8 c-0.6,1.8-1.1,3.6-1.4,5c-0.2,1,0.2,1.7,0.4,2.1c0,0,0.1,0.1,0.1,0.1c0.3,0.8,1.1,1.2,1.9,1.2c0.3,0,0.5-0.1,0.8-0.2 c0,0,0.1,0,0.2-0.1c0.4-0.1,1.1-0.4,1.6-1c1.2-1.5,1.9-3.4,2.2-6c0.1,0.1,0.1,0.1,0.2,0.2c0.3,0.3,0.6,0.7,1,1 c0.4,0.4,0.9,0.6,1.3,0.8c0.1,0.1,0.2,0.1,0.3,0.2c0.1,0.1,0.2,0.1,0.3,0.1c-0.3,0.3-0.7,0.5-1,0.9c-0.6,0.6-0.7,1.4-0.7,1.8 c0,0.1,0,0.2-0.1,0.3c-0.1,0.3-0.1,0.6,0,0.9c0.1,0.2,0.1,0.5,0.2,0.7c0.1,0.6,0.3,1.4,0.5,2.1c0.4,1.3,1.5,2.1,2.7,2.1 c0.9,0,1.7-0.5,2.3-1.2c0.6-0.8,0.9-1.7,1.2-3.1c0.2-0.8,0.1-1.7-0.3-2.7c-0.2-0.6-0.5-1.1-0.8-1.5c-0.1-0.1-0.2-0.3-0.2-0.4 c-0.3-0.5-0.7-0.8-1.3-1c0,0,0.1-0.1,0.1-0.1c0-0.1,0.1-0.2,0.1-0.3c0.1-0.2,0.2-0.3,0.3-0.5c0.1,0.2,0.1,0.4,0.2,0.6 c0.4,0.8,1.1,2.2,2.4,2.7c0.3,0.1,0.6,0.2,1,0.2c1.2,0,2.5-0.7,3.1-1.8c0.5-0.8,0.5-1.8,0-2.5c-0.6-0.9-1.3-1.7-1.9-2.5 c-0.3-0.3-0.6-0.6-0.8-1c-0.4-0.5-1-0.7-1.6-0.7c-0.6,0-1.2,0.3-1.6,0.8c-0.1,0.1-0.2,0.2-0.2,0.3c-0.1,0.2-0.3,0.4-0.4,0.6 c-0.1-1.4,0.2-2.4,1-3.3c1-1.1,1-2.8,0.8-4c-0.3-1.6-0.9-3.1-1.4-4.5c-0.3-0.9-0.8-1.7-1.3-2.3c0.7-0.4,1.3-0.8,1.9-1.3 c1.7-1.6,3.1-3.3,4.5-5.1c0.5-0.6,0.8-1.5,0.9-2.3c2-0.1,3.6-0.2,5.2-0.3c1.3-0.1,2.7-0.3,4-0.4c1.6-0.2,3.2-0.3,4.8-0.5 c0.9-0.1,1.7-0.1,2.7-0.1c1,0,2,0,3-0.1c1.2-0.1,2.5-0.2,3.7-0.4c1.3-0.2,2.7-0.3,4.1-0.4c1.4-0.1,4-0.3,4.9-2.9 c1.1,0.4,2.1,0.8,2.8,1.4c0.9,0.7,1.9,1.1,3.1,1.1c0.5,0,0.9-0.1,1.2-0.1c0.4-0.1,0.9-0.1,1.3-0.2c0.1,0.6,0.2,1.2,0.3,1.9 c0.1,0.6,0.4,1,0.5,1.3c0,0,0.1,0.1,0.1,0.1c0.1,0.3,0.3,0.6,0.4,0.9c0.1,0.2,0.2,0.4,0.3,0.5c-0.1,0.6-0.2,1.3-0.3,1.9 c-0.1,0.8-0.2,1.5-0.4,2.2l-0.1,0.1c-0.6,1.6-1.2,3.2-1.8,4.9c-0.3,0.8-0.4,1.6-0.4,2.4c-0.2,0-0.4-0.1-0.6-0.1 c-0.1,0-0.3,0-0.4-0.1c-0.8-0.1-1.5,0.2-2,0.8c-0.3,0.4-0.4,0.9-0.4,1.4c-0.1,0.1-0.2,0.2-0.2,0.2c-0.9,0.9-1.8,1.9-2.5,3.1 c-0.7,1.3,0,2.6,0.5,3.5l0.1,0.2c0.2,0.3,0.7,1.1,2,1.1c0.2,0,1.4,0,2.2-0.7c0.9-0.8,1.9-1.7,2.8-2.7l0.1,0.3 c0.2,0.7,0.7,1.6,1.4,2.2c-0.3,0.1-0.6,0.3-0.8,0.5c-0.8,0.7-1.1,1.7-1.2,2.5c-0.1,1-0.3,2.2-0.2,3.3c0.1,1.3,1.2,2.2,1.7,2.6 c0.4,0.3,0.8,0.4,1.3,0.4c1.1,0,2.5-1.1,2.8-2.2c0.3-0.9,0.5-1.9,0.7-2.9c0.1-0.4,0.2-0.8,0.2-1.2c0-0.1,0-0.3,0-0.5 c0,0.1,0.1,0.1,0.1,0.2c0.8,1.3,2.5,1.4,2.7,1.4c0.8,0,1.3-0.3,1.6-0.5c0.9-0.8,1.2-2.1,1.1-3c-0.1-1-0.5-1.8-0.8-2.4 c-0.3-0.5-0.7-0.9-1.1-1.1c-0.1-0.1-0.2-0.2-0.4-0.3c-0.2-0.2-0.5-0.4-0.8-0.4c0.5-0.4,1.1-0.9,1.6-1.6c2.3-3.2,3-6.6,2.1-10.1 c0.1-0.2,0.2-0.4,0.3-0.6c1.5-0.2,2.8-1,4-2.3c0.2-0.3,0.5-0.5,0.8-0.8c0.4-0.4,0.9-0.9,1.3-1.4c1.6-2.1,3.3-4.6,3.5-7.8 c0,0,0,0,0,0c0.3-0.1,0.5-0.2,0.7-0.3c0.1,0,0.1-0.1,0.2-0.1c1.8-0.5,2.8-1.9,2.8-3.9c0-0.3,0-0.7,0-1c1,0.3,1.9,0.7,2.9,1 c0.8,0.3,1.6,0.5,2.3,0.8c0.9,0.3,1.8,0.6,2.6,0.8c1.6,0.4,3,0.8,4.3,1.6c1.4,0.9,2.6,1.4,3.8,1.4c2.5,0,4.9-0.2,7.3-0.4l0.9-0.1 c0.3,0,0.7,0,1-0.1c1.3-0.1,2.8-0.2,4.2-0.7c1-0.4,2.1-0.4,3.3-0.5c0.7,0,1.4-0.1,2.1-0.2c0.9-0.1,1.9-0.2,2.8-0.3 c1.3-0.1,2.6-0.3,3.9-0.5c1.3-0.2,2.3-1.1,3-1.8c0.5-0.5,0.9-1.3,0.8-2.3 M45.6,162.2c-1,0.3-2,0.8-3.1-0.3 c0.8-0.9,1.4-2.2,2.9-1.7c0.5,0.2,0.9,0.8,1.3,1.2C46.4,161.7,46,162.1,45.6,162.2z M193.2,216.7c0.1-0.3,0.3-0.5,0.6-0.9 c1,1.2,1.9,2.1,2.6,3.2c0.3,0.6-0.9,1.5-1.6,1.2C194,219.9,192.9,217.5,193.2,216.7z M238.1,210.2c-1.1,1.2-2.3,2.3-3.5,3.4 c-0.2,0.2-1,0.3-1,0.2c-0.3-0.6-0.8-1.4-0.6-1.8c0.5-1,1.3-1.8,2.1-2.6c0.6-0.6,1.3-1,0.8-1.8c0.5,0.1,1,0.1,1.4,0.3 c0.4,0.2,1,0.4,1,0.8C238.6,209.1,238.5,209.9,238.1,210.2z M209.8,141.6c0.1,0,0.1-0.1,0.1-0.1c-0.1,0.3-0.1,0.6-0.2,0.9 c-0.3,1.5-0.8,3.5,0.3,5.5l0,1.5c0,1.6,0,3.2,0,4.9c-1.1-0.2-2.1-0.4-3.2-0.5c-0.9-0.1-2-0.1-3.1-0.1c-0.8,0-1.5,0-2.3,0 c-1.8,0.1-3.6,0.2-5.3,0.3l-0.5-18.4c0.6,0.7,0.9,1.2,1,1.7c0,0.5,0.2,0.9,0.5,1.3c-0.5,0.5-0.8,1.2-0.9,1.7 c-0.1,0.3-0.1,0.7-0.1,1c-0.2,0.4-0.3,0.9-0.1,1.4l0.2,0.6c0.2,0.7,0.4,1.4,0.6,2.1c0.2,0.5,0.8,1.4,2.4,1.4 c1.3,0,1.9-0.6,2.2-1.2c0.1-0.1,0.1-0.2,0.1-0.3c0.1,0.2,0.1,0.4,0.2,0.6c0.4,0.9,1.5,1.8,2.7,1.8c0.2,0,0.4,0,0.6-0.1 c1-0.3,1.5-1.1,1.7-1.5l0.1-0.1c0.4-0.5,0.5-1.2,0.3-1.8c-0.1-0.3-0.2-0.5-0.2-0.8c-0.2-0.7-0.4-1.3-0.7-1.9 c0-0.1-0.1-0.1-0.1-0.2c0.6,0.4,1.2,0.7,1.8,0.8c0.1,0,0.3,0,0.4,0c0.7,0,1.2-0.3,1.6-0.5C209.7,141.6,209.7,141.6,209.8,141.6z  M198.2,140.7c0.1-0.3,0.4-0.9,0.6-0.9c0.4,0,0.9,0.3,1,0.6c0.6,1.4,0.5,2.8-0.2,4.2c-0.1,0.1-0.9,0.1-0.9,0 c-0.3-0.8-0.5-1.6-0.7-2.5c0.1,0,0.2,0,0.2-0.1C198.1,141.6,198.1,141.1,198.2,140.7z M202.8,142.7c0-0.3,0.3-0.6,0.5-1 c0.3,0.2,0.8,0.3,0.9,0.6c0.3,0.7,0.5,1.5,0.9,2.4c-0.2,0.3-0.4,0.8-0.7,0.9c-0.2,0.1-0.8-0.3-0.9-0.6 C203.2,144.3,203,143.5,202.8,142.7z M206,136.1c0.1-0.1,0.6,0.1,0.8,0.3c0.7,0.8,1.3,1.7,1.9,2.6c0.1,0.2,0.1,0.4,0.3,0.7 c-0.3,0.1-0.7,0.4-0.9,0.4c-1.1-0.2-2.6-1.9-2.6-3.1C205.4,136.8,205.7,136.3,206,136.1z M177.2,85.8c0.3,0,0.7,0.1,0.8,0.3 c0.1,0.2-0.1,0.7-0.3,0.8c-0.9,0.5-1.8,0.9-2.9,1.4c-0.8-0.5-1.5-0.7-2-1.3c-0.5-0.5-0.1-1.2,0.6-1.2 C174.6,85.8,175.9,85.8,177.2,85.8z M172.9,89.6c-0.3-0.1-0.5-0.1-0.8-0.1c0-0.1,0-0.3-0.1-0.4C172.3,89.3,172.6,89.5,172.9,89.6z  M169.7,83.1c0.7-1.4,1.9-2,3.4-2.3c0.2,0,0.5,0.3,0.9,0.5c-0.3,0.5-0.5,0.8-0.7,1.1c-0.6,0.7-1.3,1.4-2,1.9 c-0.3,0.2-1.1,0.4-1.2,0.2C169.7,84.1,169.5,83.4,169.7,83.1z M167.7,84c0,0.1,0,0.2,0.1,0.3c0,0-0.1,0-0.1,0 C167.6,84.2,167.7,84.1,167.7,84z M163.6,83.7c0.3-1,0.4-1.8,0.8-2.4c0.4-0.7,1.3-0.7,1.4,0.1c0.1,0.9,0.1,1.8-0.1,2.7 c-0.1,0.4-0.8,0.9-1,0.9C164.2,84.6,163.9,84,163.6,83.7z M134.7,89.9c1-0.9,2-1.9,3.2-2.6c0.7-0.4,1,0.2,1.1,0.8 c0,1.5-2.9,3.5-4,2.9C134.7,90.8,134.6,90,134.7,89.9z M130.9,86.1c-0.3-0.7-0.4-1.6-0.4-2.4c0-0.4,0.3-0.8,0.5-1.2 c0.3-0.4,0.7-0.7,1-1c0.3,0.4,0.6,0.9,0.9,1.3c0.1,0.1,0,0.3,0.1,0.5c0,0-0.1,0-0.1,0c0.1,0.7,0.2,1.5,0.1,2.2 c0,0.4-0.4,0.9-0.7,1C131.8,86.6,131,86.4,130.9,86.1z M126.8,92.2c-0.1-0.1-0.6-0.4-0.8-0.9c-0.4-1-0.6-2.1,0.3-2.9 c0.1-0.1,0.5-0.2,0.6-0.1c0.6,0.7,1.4,1.3,1.7,2.1C129.2,91.6,128.6,92.3,126.8,92.2z M47.1,151.9c1.5,0.7,2.7,1.6,3.4,3.1 c0.1,0.3,0,0.8-0.2,1.1c-0.1,0.2-0.6,0.2-0.9,0C48,155.5,46.9,153.5,47.1,151.9z M52,169.5c-0.2,0.4-1.1,0.8-1.3,0.7 c-0.5-0.3-0.7-1-1.2-1.7c0.7-1.1,1.4-2.1,2.1-3c0.1-0.2,0.8-0.2,1,0c0.3,0.3,0.6,0.9,0.5,1.2C52.8,167.7,52.5,168.7,52,169.5z  M94,236.8c-0.1,0.3-0.9,0.4-1.4,0.6c-0.1-0.5-0.4-1-0.3-1.5c0.5-1.6,1.1-3.2,1.8-4.7c0.2-0.4,0.7-0.7,1.2-0.8 c0.2,0,0.5,0.5,0.8,0.9C95.3,233.2,94.7,235,94,236.8z M96.9,234.9c0-0.1,0.1-0.2,0.1-0.3c0,0,0.1,0,0.1,0.1 C97,234.7,96.9,234.8,96.9,234.9z M99.7,239.2c-0.6,0.6-1.3,0.5-1.6-0.3c-0.5-1.4,0.3-3.3,1.8-4.1 C100.6,236,100.5,238.3,99.7,239.2z M104.5,231.6c0.1,0.1,0.2,0.2,0.3,0.3c0.3,0.4,0.9,1,0.8,1.1c-0.3,0.5-0.8,1.1-1.3,1.2 c-0.4,0.1-1-0.5-1.4-0.9c-0.2-0.2-0.2-0.7-0.4-1.2c0.2-0.4,0.5-1,0.9-1.3C103.6,230.8,104.1,231.4,104.5,231.6z M131.6,205.2 c-0.3,0.1-1-0.2-1.3-0.5c-0.4-0.4-0.5-1.1-0.8-1.8c0.3-0.5,0.6-0.9,0.9-1.4c0.3,0.3,0.7,0.6,1,0.9c0.3,0.3,0.5,0.6,0.7,1 C132.5,204.2,132.2,204.9,131.6,205.2z M131.9,200.4C132,200.3,132,200.3,131.9,200.4C132,200.4,132,200.4,131.9,200.4 C132,200.4,132,200.4,131.9,200.4L131.9,200.4z M137.7,199.5c0.3,0.2,0.4,1.1,0.3,1.6c-0.1,0.3-0.8,0.7-1.2,0.6 c-0.8-0.1-1.6-0.4-2.3-0.9c-0.4-0.2-0.6-1-0.5-1.4c0.1-0.4,0.7-0.7,1.1-1.1C136.1,198.8,137,199,137.7,199.5z M181.5,223.1 c-0.2,0.3-0.7,0.3-1,0.5c-0.1-0.3-0.5-0.7-0.4-1c0.4-1.6,0.8-3.2,1.3-4.8c0.1-0.3,0.9-0.7,1.2-0.6c0.3,0.1,0.5,0.7,0.6,0.9 C183.1,220.2,182.6,221.7,181.5,223.1z M191.4,223.3c0.2,0.5,0.3,1.1,0.2,1.7c-0.2,0.8-0.4,1.6-0.9,2.3c-0.5,0.7-1.2,0.4-1.4-0.3 c-0.3-0.9-0.4-1.8-0.6-2.6c0.1-0.5,0.1-1,0.3-1.3c0.4-0.5,1-0.9,1.6-1.3C190.8,222.2,191.2,222.7,191.4,223.3z M242.1,221.6 c-0.1,0.3-0.8,0.8-0.9,0.8c-0.4-0.3-1-0.8-1-1.3c-0.1-0.9,0.1-1.9,0.2-2.9c0.1-0.5,0.2-1,0.6-1.3c0.3-0.3,0.9-0.4,1.3-0.2 c0.4,0.2,0.6,0.7,0.8,1C242.6,219.1,242.4,220.4,242.1,221.6z M243.4,215.1c0.2-0.1,0.3-0.2,0.5-0.3c0.1,0.4,0.2,0.7,0.3,1.1 C244,215.7,243.8,215.4,243.4,215.1z M247.7,214.2c0.3,0.5,0.5,1,0.6,1.6c0,0.4-0.1,1.1-0.4,1.3c-0.2,0.2-1,0-1.2-0.3 c-0.4-0.7-0.7-1.5-0.8-2.4c-0.1-0.3,0.5-0.7,0.8-1.2C247.2,213.7,247.5,213.9,247.7,214.2z M284.6,129.6c-0.3,0.6-0.9,1.3,0,1.9 c0.7,0.5,1.5,1.2,2.4,0.2c0.8-0.8,1.6-0.1,2,0.5c2.1,2.6,2.3,5.2-0.7,7.3c-0.6,0.4-0.7,0.8-0.4,1.5c2.4,5.1,4.8,10.2,7.3,15.2 c0.5,1.1,1.5,1.9,2,3c0.7,1.3,1.2,2.7,1.8,4c1.2,2.6,2.5,5.2,3.8,7.9c1.4,2.8,2.8,5.5,4.2,8.2c0.3,0.6,1,1.1,0.4,1.8 c-0.5,0.5-1.2,1.1-1.8,1.2c-2.2,0.4-4.4,0.5-6.6,0.8c-1.9,0.3-3.9,0.1-5.8,0.8c-1.5,0.5-3.1,0.5-4.7,0.6c-2.7,0.2-5.3,0.5-8,0.5 c-0.9,0-1.9-0.5-2.7-1c-2.3-1.5-4.9-1.7-7.4-2.6c-2.2-0.8-4.4-1.5-6.5-2.3c-0.7-0.3-1.2-0.3-1.2,0.6c-0.1,0.9-0.2,1.9-0.1,2.8 c0,1-0.4,1.6-1.4,1.9c-0.3,0.1-0.7,0.3-1,0.4c-0.9,0.2-1.2,0.7-1.3,1.7c-0.2,2.6-1.6,4.7-3.1,6.7c-0.6,0.8-1.4,1.4-2.1,2.2 c-1,1.2-2.2,1.8-3.6,1.6c-0.4,0.7-0.7,1.3-1,1.8c-0.1,0.3-0.2,0.6-0.2,0.9c0.9,3.2,0.1,6.2-1.7,8.8c-0.6,0.9-1.7,1.5-2.5,2.2 c-0.5,0.5-1,1.1-1.3,1.7c-0.4,0.8-1,1.1-1.6,0.8c-0.4-0.1-0.7-0.8-0.9-1.3c-0.6-1.7-1.1-3.4-1.5-5.1c-0.2-0.9-0.1-2,0.2-2.9 c0.6-1.7,1.2-3.3,1.8-4.9c0.6-1.5,0.5-3,0.9-4.5c0.2-0.7-0.5-1.6-0.9-2.4c-0.1-0.3-0.4-0.6-0.5-0.9c-0.2-1.3-0.3-2.6-0.5-4.1 c-1.3,0.3-2.2,0.7-3.2,0.8c-1,0.1-1.8,0.2-2.8-0.6c-1.4-1.1-3.2-1.6-4.8-2.3c-0.2-0.1-0.9,0.6-0.9,1c-0.3,2.1-1.7,2.2-3.4,2.3 c-2.6,0.2-5.2,0.6-7.7,0.8c-1.9,0.2-3.8,0.1-5.6,0.2c-2.9,0.2-5.9,0.6-8.8,0.9c-2,0.2-4,0.3-5.9,0.4c-0.8,0-1.2,0.1-1,1.1 c0.1,0.6-0.1,1.4-0.5,1.9c-1.4,1.7-2.8,3.4-4.3,4.9c-1,0.9-2.3,1.4-3.6,2.2c0.5,0.6,1,0.9,1.3,1.4c0.5,0.7,1,1.4,1.3,2.2 c0.5,1.3,1,2.7,1.3,4.1c0.1,0.7,0.1,1.8-0.3,2.2c-1.7,2-1.6,4.2-1.3,6.6c0.1,0.5-0.4,1-0.5,1.5c-0.4-0.3-0.9-0.5-1.3-0.8 c-0.8-0.7-1.4-1.7-2.3-2.2c-2.1-1.3-3.8-3.1-4-5.6c-0.1-1.5-0.7-2.8-1.1-4.2c-0.1-0.5-0.1-1.1-0.2-1.7c-0.2-1.2-1.3-2-2.2-1.5 c-1.6,0.8-2.9-0.1-4-0.8c-1.9-1.1-3.7-2.3-5-4.2c-0.3-0.5-1-0.7-1.4-1.1c-1.1-1.1-2.1-2.2-3.1-3.4c-0.8-0.9-1.5-2-2.3-2.9 c-0.3-0.3-0.9-0.4-1.3-0.5c-0.8-0.2-1.6-0.3-2.5-0.5c-0.7-0.1-1.4-0.2-2.1-0.4c-0.6-0.2-1.4-0.3-1.8-0.7c-0.8-0.7-1.4-0.5-2.3,0 c-2.5,1.4-4.9,2.9-7.5,4c-2.6,1.1-5.1,2.3-8.1,2.3v0l0,0c0,0-0.1,0-0.1,0c-2.3,0-4.6,0.8-7.2,1.3c0.8,0.3,1.4,0.4,1.9,0.7 c0.8,0.4,1,1.2,0.3,1.6c-1.8,1.2-3.6,2.4-5.5,3.2c-1.1,0.5-2.5,0.8-3.7,0.6c-1.7-0.3-3.2-1.1-4.8-1.8c-0.7-0.3-1.2-0.9-1.8-1.3 c-0.6-0.4-1.2-0.7-1.7,0.2c-0.2,0.3-0.5,0.4-0.8,0.7c-0.4,0.4-0.9,0.8-1.1,1.3c-0.8,1.7-1.7,3.3-2.2,5.1c-1.1,3.7-4,5.3-7.1,6.9 c-0.6,0.3-1.1,0.6-1.7,0.9c-0.2,1.3,0.1,2.3,1,3.4c0.9,1.2,1.5,3,1.7,4.6c0.5,3.4-0.7,6.2-3.1,8.6c-0.5,0.5-0.7,1.3-1.1,1.8 c-0.2,0.3-0.8,0.6-1,0.5c-0.3-0.1-0.5-0.6-0.6-1c-0.7-2.1-0.6-4.5-2.4-6.1c-2.1-1.9-1.7-4.3-1.5-6.7c0.1-0.6,0.3-1.2,0.4-1.9 c0-0.2-0.1-0.5-0.2-0.7c-0.5-0.9-0.6-1.7,0-2.5c0.5-0.6,0.3-0.9-0.3-1.2c-0.6-0.2-1.2-0.5-1.8-0.7c-0.8-0.4-1.5-0.7-2.2-1.1 c-0.2-0.1-0.4-0.3-0.5-0.5c-0.1-1.1-0.9-1.4-1.6-2c-2.6-1.9-3.7-4.6-4.3-7.7c-0.3-1.7-0.5-1.5-2-1.3c-1.5,0.2-2,1.5-3,2.1 c-2.4,1.4-4.9,1.7-7.5,0.6c-1.1-0.5-2.2-1.1-3.2-1.7c-0.8-0.5-0.9-1.2-0.2-1.8c1.8-1.6,3.6-3.2,5.5-4.7c1.3-1.1,2.9-1.2,4.6-0.7 c0.7,0.2,1.4,0,2.1,0c0-0.2,0-0.3,0.1-0.5c-1.3-0.6-2.7-1.1-4-1.7c-0.1,0-0.2-0.1-0.3-0.1c-3.7-1.2-4.7-4.1-4.9-7.7 c-0.2-3.3-0.4-6.5-0.6-9.8c-0.1-1.8,0-3.7,0.2-5.5c0.2-1.3,0-2.2-1-3.1c-1.3-1.1-2.5-2.5-3.7-3.8c-0.9-1-1.7-0.9-2.5,0.2 c-0.4,0.6-1,1.2-1.5,1.7c-1.5,1.5-3.3,1.5-5.2,1.1c-0.4-0.1-0.9-0.2-1.3-0.2c-1.9,0.2-3.6-0.6-5-1.8c-0.4-0.4-0.6-1.3-0.6-1.9 c0-0.3,0.7-0.7,1.2-0.9c1.3-0.6,2.6-1.1,3.5-2.4c0.6-0.9,1.9-1.3,2.9-1.8c1.1-0.6,2.2-0.4,3.2,0.4c1.2,1,2.2-0.3,3.3-0.6 c0.9-0.2,0.7-1,0.8-1.7c0.3-5.1,1.6-9.9,4.9-13.9c0.5-0.7,0.6-1.3,0.5-2.1c-0.1-1.6,0.3-3.1,0.3-4.7c0.1-1.9,0-3.7,0.1-5.6 c0-2.1,0.3-4.2,0.1-6.2c-0.2-2,0.3-3.9-0.1-6c-0.4-1.9-0.1-4-0.1-6c0-2.8,0-5.6,0.1-8.4c0.1-1.1,0.3-2.4,1.7-2.8 c1.9-0.5,3.9-1,5.7-1.9c3-1.5,6.2-1.5,9.4-1.9c0.5-0.1,1,0.2,1.5,0.2c0.6,0,1.4-0.1,1.8-0.4c1.9-1.7,3.8-3.5,6.2-4.5 c0.6-0.2,1-0.9,1.4-1.3c0-0.6-0.1-1.3-0.1-1.9c0-0.3-0.1-0.7-0.3-0.9c-1.3-1.3-0.9-3-1-4.5c-0.1-3,1.2-5.6,2.9-8 c0.5-0.7,1-1.4,1.6-1.9c0.6-0.6,1.2-0.3,1.7,0.5c0.8,1.3,1.7,2.5,2.3,3.8c0.5,1.2,0.6,2.6,1,3.9c0.7,2.3-0.4,4.2-1,6.3 c-0.2,0.7-0.3,1.5-0.2,2.2c0.1,0.6,0.6,1.3,1,1.5c2.7,1.3,5.1,2.8,7.2,5c1,1,2.2,0.5,3.2,1c0.4,0.2,0.9,0.2,1.3,0.5 c2,1.5,4.4,2.1,6.8,2.5c0.6,0.1,1.2,0.3,1.7,0.4c1,0.3,1.5-0.1,1.8-1.2c0.2-0.6,0.7-1.2,1-1.8c0.5-1.1,0.9-2.2,1.4-3.3 c0.2-0.5,0.4-1,0.8-1.3c0.6-0.5,1.2-0.2,1.7,0.4c0.8,1,1.6,2,2.5,3c1.3,1.6,1.6,3.5,1.4,5.4c-0.1,1.3,0.2,2,1.5,2.3 c0.8,0.2,1.5,0.6,2.3,1c0.8,0.4,1.5,1,2.5,0.4c0.2-0.1,0.8,0.2,1.3,0.4c0-0.2,0.1-0.5,0-0.8c-0.5-1.5-0.2-3.2-1.2-4.7 c-1.1-1.8-0.1-3.8,1.8-4.7c0.3-0.1,0.6,0,0.9,0c1.6,0.2,3.2,0.3,4.9-0.3c1.7-0.6,3.6-0.9,5.4-0.9c1.4,0,2.3-0.5,3.2-1.5 c0.9-1,1.9-1.4,3.2-1.6c1.7-0.2,3.3-1.1,4.7-2.3c0.4-0.4,1.2-0.7,1.6-0.6c0.4,0.1,0.6,0.9,0.8,1.5c0.2,1,0.3,2.1,0.6,3.1 c0.1,0.3,0.5,0.8,0.7,0.7c1.9-0.2,3.4,1.1,5.2,1.4c2.9,0.5,5.4,2,8.1,3.2c0.6,0.2,1.3,0.1,1.9,0.4c1.2,0.5,2.3,1.1,3.5,1.7 c0.3,0.2,0.6,0.5,0.9,0.5c1,0,1.3,0.6,1.3,1.5c0,0.8-0.1,1.6-0.1,2.4c0,0.9,0.2,1.7,0.3,2.6c0.1,0.6,0.3,1.2,0.1,1.7 c-0.7,2,0.4,3.2,1.8,4.2c3,2.1,4.5,5.1,4.7,8.7c0.1,2.1,0.5,4.2,1.6,6.1c0.2,0.3,0.5,0.5,0.8,0.7c4,1.9,5.2,7,3.5,10.3 c-0.5,1-0.9,2.1-1.4,3.1c-0.8,1.4-1.5,1.3-2.4,0c-0.6-0.9-1.3-1.7-2-2.6c0-0.1-0.1-0.1-0.2-0.2c-0.1-2-1.9-3-2.6-4.5 c-0.4-0.9-0.6-1.8-0.8-2.8c-0.2-0.8-0.4-1.6-1.2-1.6c-0.7,0-1,0.7-1.1,1.5c-0.5,2.1,0,4,0.1,6.1c0.1,1.8,0.1,3.5,0.3,5.3 c0.2,3,0.5,6,0.7,8.9c0.1,1.5,0,3,0,4.5c0,1.2,0.6,1.6,1.7,1.5c2-0.2,4-0.3,6-0.4c1.7-0.1,3.4-0.1,5.1,0.1 c1.7,0.1,3.3,0.5,5.2,0.9c0.1-0.4,0.2-0.9,0.2-1.4c0-2.6,0-5.1,0-7.7c0,0,0-0.1,0-0.1c-1.6-2.5,0.3-4.9,0-7.4 c-0.3-1.9-0.3-3.8-0.5-5.7c-0.1-0.4-0.6-0.8-0.9-1.2c-0.5-0.6-0.7-1.2,0.3-1.6c0.3-0.1,0.6-0.7,0.6-1.1c-0.2-3-0.6-6-0.8-9 c-0.1-1.2-1-1.7-1.7-2.4c-1.3-1-1.4-4.7,0-5.3c2.4-1.1,2.6-3.2,2.8-5.3c0.2-2.8,0.4-5.6-0.5-8.4c-0.1-0.4,0-0.9,0.2-1.3 c0.7-1.8,0-3.4-0.3-5.1c-0.4-2.2,0.7-4.5,2.7-5.1c0.2-0.1,0.4-0.1,0.6-0.1c2.5-0.2,5-0.5,7.6-0.7c1.7-0.1,3.5-0.1,5.2-0.2 c1.8-0.1,3.6-0.1,5.3-0.7c1.4-0.5,3-0.6,4.5-0.4c2.5,0.4,5,1.2,7.5,1.9c1.7,0.5,3.4,1.2,5,1.9c1.8,0.7,2.4,0.5,3.6-1 c0.5-0.7,1.1-1.4,1.6-2.1c0.9-1.1,1.9-1.5,3.4-1.4c2.3,0.2,4.5,0,6.8-0.2c1.5-0.1,3.1-0.2,4.6-0.4c2.1-0.3,4.2-0.8,6.3-1.1 c2.7-0.4,5.4-1,8-1c2.3,0.1,4.7,0.5,6.7,2c0.4,0.3,1,0.2,1.5,0.4c2,0.8,4,1.6,6.1,2.4c1.3,0.5,2.6,1,3.9,1.5c1,0.4,2,0.7,3,1 c0.5,0.2,1.1,0.4,2,0.5c-0.2,1.3-0.2,2.8-0.8,3.9c-1.4,2.7-3,5.4-4.5,8c-1.9,3.2-3.9,6.4-5.9,9.6c-0.3,0.4-0.4,1-0.6,1.6 c1.3,0.3,2.4,0.7,3.6,0.2c1-0.4,2.1-0.7,3.2-1c1.7-0.4,3,0.7,4.3,1.4c1.7,1.1,3.3,2.5,4.8,3.8c0.8,0.7,0.7,1.7-0.4,2.5 c-1,0.8-2,1.7-3.2,2.1c-0.9,0.4-2.1,0.2-3.2,0.2c-1.2-0.1-2.5,0-3.5-0.5c-1.3-0.6-2.9,0.1-4-1.2c-0.2-0.2-0.6-0.1-0.9-0.2 c-0.5-0.1-1.1,0-1.5-0.2c-2.1-1.4-3.5,0.3-5.1,1.1c-0.6,0.3-0.7,1.3-1.1,1.9C287,125.8,285.8,127.7,284.6,129.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M240.3,173.6c-1.4-0.8-3-1.4-4.7-2.1c0,4.9,0,9.5,0,14.4c1.2-0.2,2.2-0.5,3.1-0.5c1.7-0.1,2.6-0.9,2.6-2.6 c-0.1-2.5-0.3-5-0.5-7.4C240.7,174.7,240.6,173.8,240.3,173.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M236.3,168.4c0-0.3,0-0.7,0.1-1c0.4-1.5,0.5-2.9-1-3.9c-1.1-0.7-2.3-1.4-3.5-2.1c-0.7,1.9,0.5,4.3,2.5,5.6 c0-0.3,0.1-0.5,0.2-1.1c0.6,1.1,1,1.9,1.4,2.7C236.1,168.5,236.2,168.5,236.3,168.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M240.4,171.3c0.1-0.9,0.2-1.5,0.1-2c-0.1-0.4-0.4-0.8-0.7-1c-0.3-0.2-1-0.1-1,0c-0.2,0.5-0.3,1.1-0.1,1.5 C239,170.3,239.6,170.7,240.4,171.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M249,188.4c1,0.3,1.8-0.8,1.8-2.3c-0.7,0.1-1.3,0.2-1.9,0.4c-0.4,0.1-0.7,0.4-1.1,0.7 C248.2,187.6,248.5,188.3,249,188.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M274.6,121.9c-1.9,2.6-0.5,5.3-0.6,8.1c2.8-1,4.6-3.4,4.5-6.1c0-0.9-0.7-1.8-1.3-2.5 C276.4,120.7,275.1,121.1,274.6,121.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M261.6,120.3c0.1-0.2,0.3-0.3,0.3-0.5c0.8-1.9,1.6-3.8,2.5-5.7c0.6-1.3,1.4-2.4,2.2-3.6 c0.4-0.6,0.3-1.1-0.4-1.3c-1.8-0.6-3.6-1.2-5.6-1.8c0.3,4.5,0.5,8.7,0.7,12.9C261.3,120.2,261.4,120.3,261.6,120.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M260.9,159.8c-2.5-1.6-5.4-2.3-7.7-4.3c-2.9-2.5-6.1-4.6-8.5-7.7c-2.5-3.3-4.6-6.7-5-11 c0-0.5-0.3-1-0.5-1.5c-0.5-1.5-1.2-3-1.4-4.5c-0.3-3.4-2.1-5.7-4.5-7.6c-1.4-1.1-3.3-1.7-5-2.5c-0.7-0.4-1.5-0.6-2.3-1 c-1.7-0.8-3.3-1.8-5-2.5c-1.1-0.5-2.4-0.5-3.6-0.8c-0.9-0.2-1.8-0.5-2.7-0.8c-1.1-0.1-1.3,0.8-1.6,1.5c-0.4,0.8,0.4,1,0.9,1.3 c0.3,0.2,0.6,0.6,0.9,0.8c0.6,0.5,1.2,1,1.9,1.3c1,0.5,2,0.7,3,1.1c1.4,0.6,2.7,1.2,4,1.7c0.7,0.3,1.5,0.8,2.2,0.8 c1.1,0,1.9,0.6,2.6,1.3c0.4,0.5,0.9,0.9,1.4,1.3c0.6,0.6,1.1,1.1,1.6,1.7c0.5,0.7,0.9,1.4,1.9,1.3c0.2,0,0.6,0.3,0.7,0.5 c0.4,1.7,2,3,1.6,4.9c0,0,0,0.1,0,0.1c1.1,2.9,2.2,5.8,3.3,8.6c0.6,1.4,1.2,2.8,2,4c1.1,1.6,2.5,3,3.8,4.4 c0.9,0.9,1.9,1.8,2.9,2.6c0.7,0.6,1.6,0.8,2.4,1.4c2.4,1.7,4.6,3.5,7,5.1c1,0.7,2.1,2.2,3.6,0.6c0.4-0.4,0.8-0.7,1.2-1 C261.8,160.5,261.4,160.1,260.9,159.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M279,117.6c-0.1-1.5-1.5-0.6-2.4-1.4c-0.2,0.8-0.5,1.8-0.5,1.8c0.7,0.3,1.5,0.6,2.3,0.7 C278.6,118.7,279,117.9,279,117.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M286.3,119.1c-1.7-0.3-3.3-0.6-5.2-0.9c-0.3,0.9-0.8,1.7-0.9,2.7c-0.1,0.7,0.2,1.5,0.3,2.3 c0.1,4.7-3,8.9-7.8,10.2c-0.9,0.2-1.5-0.1-1.4-1.1c0-0.8,0.4-1.6,0.4-2.4c0-1.4-0.1-2.8-0.1-4.2c0-1.2-0.1-2.4,0.2-3.5 c0.3-1.2,1.2-2.2,1.7-3.4c0.3-0.7,0.3-1.6,0.6-2.2c0.7-1.2,0.1-1.5-0.9-1.6c-1.1-0.1-1.8-0.6-2.3-1.5c-0.4-0.6-0.9-1.2-1.3-1.7 c-0.7-0.8-1.6-0.8-2.1,0c-1.9,3.5-3.9,6.9-5.7,10.4c-0.6,1.1-1.4,1.7-2.5,1.5c-0.6-9.7-1.2-19.3-1.7-28.7 c-3.7,0.2-7.1,0.4-10.5,0.6c-0.5,0-1-0.2-1.5-0.2c-2.1,0.2-4.2,0.4-6.3,0.7c-1.6,0.2-3.1,0.7-4.5,1c0,1.8,0,3.4,0,4.9 c0.1,1.3,0.9,2.6,0,4c0,0,0.1,0.2,0.3,0.4c0.1-0.2,0.3-0.4,0.5-0.8c0,0.8,0,1.4,0,2.1c-0.3,0-0.6,0-1.2-0.1 c0.3,0.9,0.6,1.5,0.8,2.2c0.1,0.4,0.2,0.8,0.1,1.2c-0.1,1.1-0.3,2.1-0.3,3.2c0,1.9,0.1,3.8,0.3,5.7c0.1,0.6,0.2,1.3,0.5,1.8 c0.4,0.7,0.8,1.5,1.5,1.9c1.3,0.9,0.9,3.1,2.7,3.7c0.1,0,0.1,0.5,0.1,0.8c0.1,0.5,0.1,1,0.2,1.4c0.1,0.6,0.4,0.8,1.2,0.8 c1.4-0.1,2.2-0.7,3.2-1.5c2.5-2.1,5.4-2.3,8.4-1.2c0.4,0.2,0.9,0.2,1.4,0.1c1,0,1.9-0.2,2.8-0.2c0.4,0,1,0.5,1.1,0.8 c0.1,0.9-0.1,1.9-0.3,2.8c-0.4,2.1-1.7,3.5-3.6,4.2c-2.1,0.7-4.4,0.6-6.4,1.5c-0.2,0.1-0.4,0-0.6,0c-1.5,0-3-0.3-4.1,1.4 c-0.6,0.9-0.9,1.4-0.4,2.3c0.5,0.9,1,1.8,1.6,2.6c1.2,1.6,2.4,3.1,3.6,4.6c0.6,0.8,1.2,1,2,0.3c1.3-1,2.5-2.1,3.8-3 c0.9-0.7,2-1.1,3.1-1.7c1.8-0.9,3.6-2,5.5-2.7c3-1.1,6.1-1.9,9.1-2.8c0.9-0.3,1.2-0.7,1.1-1.8c-0.1-0.7,0.1-1.6,0.3-2.3 c0.2-0.7,0.9-0.8,1.3-0.2c0.3,0.4,0.4,1,0.5,1.5c0.1,0.6,0,1.2,0,2c1.1-0.6,1.9-1.2,2.8-1.6c1.4-0.6,2.8-1.2,4.1-1.8 c0.3-0.2,0.7-0.8,0.6-1.1c-0.8-2.3,0.5-4,1.4-5.8c1.1-2,2.3-4,3.4-6C287.9,119.9,287.6,119.4,286.3,119.1z M254.3,126.4 c-0.1,0.1-0.3,0.2-0.4,0.3c-0.4-0.4-1-0.7-1.1-1.2c-0.2-1-0.2-2.1-0.2-3.1c0-0.3,0.6-0.8,0.7-0.7c0.4,0.2,0.9,0.6,0.9,0.9 C254.3,123.8,254.3,125.1,254.3,126.4z M259.9,135.1c-0.2-0.4-0.3-1.1,0-1.5c0.3-0.4,0.8-0.7,1.4-0.1c0.3,0.3,1,0.3,1.5,0.5 c0.3,0.1,0.7,0.2,1.1,0.2C263,136.4,260.6,136.2,259.9,135.1z M264,129.5c-1,1-2.8,1-3.4,0.1c-0.6-0.9-0.4-1.6,0.6-1.9 c0.5-0.1,0.9-0.2,1.4-0.3c0.2,0,0.4,0,0.6,0c0-0.1,0.1-0.1,0.1-0.2c0.5,0.3,1.1,0.6,1.3,1C264.8,128.5,264.3,129.2,264,129.5z  M268.5,133.9c-0.2,0.2-0.9,0.3-1.2,0.1c-0.3-0.2-0.6-0.8-0.5-1.2c0.1-0.6,0.5-1.3,0.9-1.8c0.2-0.3,0.8-0.4,1.1-0.3 c0.3,0.1,0.5,0.6,0.8,1C269.2,132.6,269,133.3,268.5,133.9z M278.7,134c-0.2,0-0.4,0-0.6,0c-0.2-0.6-0.6-1.1-0.7-1.7 c0-0.3,0.5-0.7,0.8-1c0.4,0.5,0.9,0.9,1.1,1.4C279.4,133.1,278.9,133.6,278.7,134z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M291.2,116c0.4-0.7-0.2-1.2-0.9-1.4c-1.6-0.5-3.2-0.9-4.7-1.4c-3.1-1.1-6.4-1.8-9.2-3.7 c-0.2-0.2-0.7-0.2-0.9-0.1c-0.7,0.4-1-0.1-1.1-0.6c-0.2-1.1-1.1-1.3-1.9-1.7c-0.4-0.2-1-0.2-1.3-0.6c-1.3-1.5-3.4-1.6-4.6-3.2 c-0.1-0.2-0.4-0.2-0.7-0.3c-1.5-0.5-2.9-1-4.4-1.5c-0.7-0.2-1.2,0-1.3,0.8c-0.1,0.6,0,1.1-0.1,1.7c-0.1,0.8,0.4,1.2,1.1,1.4 c2,0.6,4,1.1,6,1.9c0.9,0.3,1.6,0.5,2.2-0.3c0.1,0.6-0.1,1.4,0.2,1.7c1.4,1.2,2.4,2.8,4.2,3.6c1.5,0.6,2.8,1.6,4.4,2.1 c2.1,0.7,4.1,1.5,6.2,2.1c1.6,0.5,3.3,0.9,5,1C290,117.5,290.8,116.6,291.2,116z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M245.6,134.2c1.7-0.7,3.4-1.1,4.9-0.6c2.4,0,3.7-0.8,4-2.3c0.1-0.3-0.2-0.8-0.5-0.9 c-0.7-0.2-1.4-0.3-2.2-0.5c-3-0.8-5.8-0.6-7.4,2.5c-0.2,0.4-0.1,1.1,0.1,1.5C244.7,134.1,245.3,134.3,245.6,134.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M266.1,161.8c0,0.6-0.1,1.2-0.3,1.7c-0.7,1.8-2.5,1.9-4,2.5c0,0.1-0.1,0.2-0.1,0.2 c0.2,2.6,0.5,5.2,0.7,7.8c0,0.2,0.2,0.5,0.4,0.7c0.8,0.6,1.6,1.2,2.4,1.7c1.3,0.7,2.6,1.5,4,2c1.5,0.5,3.1,0.5,4.7,0.9 c1.3,0.4,2.6,1,4.2,1.6c-3.9-7.2-7.6-14.2-11.4-21.2C265.8,160.2,266.1,161,266.1,161.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M263.8,161.7c-0.1,0-0.3,0-0.4,0c-0.2,0.5-0.4,0.9-0.6,1.4c0.4,0.1,0.7,0.3,1.1,0.4 c0.1-0.1,0.2-0.2,0.3-0.3C264.1,162.7,263.9,162.2,263.8,161.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M243.1,135.9c-0.5-0.8-1.1-1.5-1.7-2.4c-0.4,1.5,0.7,1.9,1.4,2.6C242.9,136.1,243,136,243.1,135.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M282.2,136c-2.5,1.3-4.9,2.6-7.4,3.8c-0.6,0.3-1.3,0.6-2,0.7c-4.1,0.5-8,1.5-11.5,3.7 c-2.7,1.7-5.5,3.3-8.1,5.1c-0.4,0.3-0.8,1.1-0.8,1.6c0,0.4,0.8,0.7,1.2,1c0.4-0.1,0.6-0.1,0.8-0.2c1-0.5,2.1-1,2.9-1.7 c2.6-2.3,5.9-2.7,8.9-4c2.3,0.5,3.8-1.5,5.9-1.9c1.4-0.3,2.6-1.2,3.9-1.9c0.3-0.1,0.5-0.2,0.8-0.3c2.4-0.8,4.8-1.6,7.2-2.5 c0.5-0.2,1.2-0.8,1.2-1.3C285.5,136.1,284,135.1,282.2,136z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M287.2,137.7c-0.1-0.6-0.1-1.2-0.2-1.7c-0.1-0.4-0.4-1-0.7-1.1c-0.4-0.1-0.9,0.2-1.6,0.3 c0.9,1.1,1.5,1.8,2.2,2.6C287,137.8,287.1,137.7,287.2,137.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M277,146c0.1-0.2-0.5-1-0.7-1c-0.5,0.1-1,0.5-1.7,0.9c0.5,0.7,0.9,1.2,1.2,1.7 C276.2,147.1,276.7,146.6,277,146z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M284.6,141.5c-1.8,0.7-3.5,1.4-5.3,2.1c-0.3,0.1-0.7,0.6-0.6,0.7c0.7,1.3,1.2,2.7,2.2,3.8 c1.1,1.3,2.3,2.3,2.8,4.2c0.8,3.2,0.1,6.3-0.2,9.5c0,0.4-0.5,1-0.8,1c-0.4,0-0.8-0.4-1.2-0.7c-0.3-0.3-0.4-0.7-0.7-0.9 c-1-0.7-2.1-1.4-3.1-2.1c-1.8-1.3-3.5-2.7-3.1-5.4c0.1-0.5,0.1-1,0-1.5c-0.1-0.9,0-2-0.4-2.8c-0.4-1-1.2-1.9-1.9-3 c-0.7,0.3-1.6,0.7-2.5,1c-2,0.6-4.1,1-6.1,1.6c-2.4,0.7-4.8,1.6-6.7,3.3c-0.4,0.4-1.2,0.8-1.2,1.2c0,0.9,0.6,1.5,1.5,1.8 c1.2,0.4,2.3,1,3.5,1.6c1,0.5,1.9,1,2.9,1.4c0.2,0.1,0.6-0.1,0.7-0.3c0.7-0.8,1.3-1.7,1.9-2.5c0.6-0.7,1-0.6,1.4,0.3 c0.2,0.5,0.6,0.8,0.9,1.3c0.3,0.6,0.7,1.2,1,1.8c0.8,1.6,1.2,3.3,2.4,4.7c1.3,1.6,2.3,3.6,3.3,5.5c0.9,1.6,1.9,3.2,2.7,4.9 c1,2.2,1.9,4.5,2.7,6.9c0.5,1.6,0.6,1.8,2.3,1.7c0.2,0,0.3,0,0.5,0c3.9,0,7.8-0.2,11.7-0.8c2.6-0.4,5.3-0.7,7.9-1 c1.8-0.2,2.1-0.7,1.4-2.5c-0.1-0.2-0.1-0.4-0.2-0.6c-0.7-1.5-1.4-2.9-2.1-4.4c-1.3-2.8-2.5-5.7-3.9-8.5c-1.7-3.4-3.5-6.7-5.2-10.1 c-0.3-0.6-0.7-1.1-1.1-1.6c-1.1-1.8-2.2-3.6-3.2-5.4c-1-1.8-1.9-3.6-2.7-5.4C285.5,141.6,285.3,141.2,284.6,141.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M125.1,159.6c-1.1-0.2-2.2,0-3.2,0c0,4.3,0,8.3,0,12.4c0,0.3,0.5,0.8,0.7,0.8c1.8-0.1,3.7-0.2,5.4-0.7 c1.3-0.3,2.6-1.1,2.6-2.8c0.1-1.2,0.1-2.4,0-3.6C130.4,161.9,128.6,160.1,125.1,159.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M158.2,171.2c-0.3-2.8-0.2-5.6-0.5-8.4c-0.4-4-1.3-8-3.7-11.3c-0.4-0.6-1-1-1.5-1.4c-1.1-1-3-1.5-2.6-3.7 c-1.6-0.7-1.7-1.1-0.6-2.4c0.9-1.1,2-2.1,2.7-3.3c1.2-1.8,2.3-3.7,3.3-5.6c0.5-0.9,1.4-1.9,0.4-3.1c-0.2-0.2,0-1,0.3-1.3 c1.3-1.5,1.1-3,0.4-4.7c-0.3-0.6-0.5-1.3-0.5-1.9c-0.2-2.2-1.2-3.6-3.3-4.2c-0.3-0.1-0.9,0-0.9,0.2c-0.3,1-1,2.2-0.7,3.1 c0.5,1.4,0.1,2.7-0.4,3.7c-0.6,1.4-1.8,2.6-2.9,3.6c-1.5,1.3-3.2,2.1-4.1,4c-0.1,0.3-0.9,0.6-1.1,0.5c-0.3-0.2-0.5-0.7-0.6-1.2 c-0.1-1.9-0.1-3.9-0.2-5.8c0-0.7-0.5-1.4-0.3-2c0.8-2.5,1.8-5,2.7-7.6c-0.1-0.2-0.3-0.3-0.4-0.5c-1.4,0.1-2.7,0.1-4.1,0.2 c-0.4,0-0.9,0.1-1.3,0.1c-0.9,0-1.7-0.1-2.6-0.1c-1.7,0.1-3.3,0.4-5,0.4c-2,0-4.1-0.6-6.1-0.5c-2.8,0.2-5.2-0.5-7.6-1.8 c-1.4-0.8-2.2-0.7-2.9,0.7c-0.9,1.8-2.7,2-4.2,2.6c-0.8,0.3-1.7,0.7-2.5,0.9c-0.6,0.1-1.3,0.2-1.8,0c-1.2-0.4-2.4-0.9-3.5-1.5 c-0.5-0.3-1-0.7-1.4-1.1c-0.4-0.5-0.4-0.8,0.2-1.3c0.8-0.5,1.4-1.2,2.1-1.8c1.6-1.6,3.3-3.2,5.5-3.9c1-0.3,2-0.6,3-0.9 c0.6-0.2,0.9-0.5,0.6-1.1c-0.1-0.4,0-1-0.2-1.3c-0.2-0.3-0.7-0.7-1-0.7c-3.1,0.2-6.1,0.5-9.2,0.7c-0.8,0.1-1.7,0-2.3,0.8 c-0.2,0.2-0.5,0.4-0.7,0.4c-1.2,0-2.3,0-3.5-0.1c-1.2-0.2-1.5,0.5-1.4,1.5c0.2,1.9,0.4,3.9,0.5,5.8c0.2,2.7,0.5,5.5,0.4,8.2 c-0.1,3.1-0.5,6.2-0.7,9.3c-0.1,1.5,0,2.9,0.1,4.4c0,1,0.2,1.9,0.2,2.9c0,0.9,0,1.7,0,2.6c0.1,1.8,0.3,3.5,0.3,5.3 c0,1.3-0.1,2.7-0.1,4c0,3.7,0.1,7.4,0,11c0,1.9,0.1,2.3,2,2.5c2.2,0.3,3.9,1.4,5.6,2.7c2.1,1.6,3.6,3.6,5.2,5.7 c1.9,2.5,3.4,5.1,4.3,8.1c0.5,1.5,0.8,3,1.1,4.6c0.2,1,0,2.1,0.1,3.2c0,0.3,0.5,0.7,0.8,0.8c0.8,0.4,1.7,0.8,2.6,1.2 c0.2,0.1,0.6,0.3,0.8,0.2c1.5-0.6,3-0.7,4.5-0.4c1.1,0.2,2.3,0.6,3.4,0.9c0.7,0.2,1.5,0.4,2.2,0.5c0.8,0,1.6-0.1,2.4-0.2 c1.3-0.1,2.6,0,3.8-0.3c2.6-0.6,5.3-1.3,7.9-2c1.3-0.4,2.7-0.8,3.9-1.4c1.9-1,3.7-2.2,5.6-3.2c2.3-1.2,4.5-2.6,5.5-5.2 C157.7,178,158.6,174.7,158.2,171.2z M117.8,126.1c0-0.1,0-0.2,0-0.2c0.1-2.3,1-2.9,3.3-2.5c1.9,0.4,3.9,0.6,5.9,1.2 c3.4,1,5.2,3.8,5.1,7.5c0,0.2,0,0.4-0.1,0.9c0.6,1.9-0.7,3.3-1.8,4.8c-0.1,0.2-0.5,0.3-0.7,0.4c-0.3,0.2-0.7,0.2-1,0.5 c-1.8,1.9-4.1,2.3-6.6,2.1c-0.1,0-0.2,0-0.4,0c-2.1,0.2-2.9-0.4-3.4-2.5C117.3,134.2,117,130.2,117.8,126.1z M126.1,175.5 c-0.5,0-1,0-1.6,0c0,0,0,0.1,0,0.1c-1.4,0-2.8,0.1-4.2,0c-0.3,0-0.8-0.5-0.9-0.8c-0.3-4-0.5-8-0.7-12c0-1.1,0.1-2.1,0.2-3.2 c0.1-1.4,2.2-2.8,3.5-2.5c2,0.4,4,0.6,6,1c0.8,0.2,1.8,0.6,2.4,1.2c1.8,1.9,2.6,4.5,3,7c0.4,2.7-0.5,5.3-2.5,7.2 C129.9,174.7,128.1,175.4,126.1,175.5z M134,189.1c-0.5,1.4-1.9,2.7-2.7,2.6c-1.1-0.1-1.7-1-1-1.8c0.7-0.8,1.7-1.5,2.7-2 C133.9,187.6,134.3,188.3,134,189.1z M136.6,133.2c-0.2-0.1-0.4-0.4-0.3-0.4c0.4-0.7,0.7-1.5,1.2-2.1c0.6-0.6,1.3-1.1,2.2-0.5 c0.2,0.2,0.4,0.4,0.5,0.5C140.1,132.4,137.9,133.8,136.6,133.2z M140.9,143c-0.1,0.3-0.8,0.7-1,0.6c-0.3-0.2-0.8-0.8-0.7-1.1 c0.2-1.3,0.6-2.6,1-3.8c0.1-0.3,0.8-0.5,1.1-0.4c0.3,0.2,0.4,0.7,0.7,1.2C141.7,140.7,141.4,141.9,140.9,143z M147.8,140.7 c-0.4,0.4-0.8,0.2-0.9-0.4c-0.1-0.8-0.2-1.7-0.3-2.5c-0.1,0-0.2-0.1-0.2-0.1c0.4-0.8,0.7-1.5,1.1-2.3c0-0.1,0.9,0.1,0.9,0.3 c0.2,1.3,0.3,2.6,0.3,3.8C148.6,139.9,148.1,140.4,147.8,140.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M96.3,215.4c0.6,0.1,1.3-0.1,2-0.3c0.2,0,0.3-0.3,0.5-0.4c-0.2-0.2-0.3-0.6-0.5-0.6c-0.8-0.1-1.7,0-2.5,0 c-0.1,0.1-0.2,0.2-0.2,0.3C95.8,214.8,96,215.4,96.3,215.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M97.9,219c-0.2,0.1-0.4,0.2-0.6,0.3c-1.6,0.8-2,3.6-0.5,4.6c1.3,0.9,1.5,2.2,1.8,3.5 c0.2,0.6,0.2,1.2,0.4,2.1c0.7-0.8,1.3-1.2,1.6-1.8c0.5-1,1-2.1,1.1-3.2c0.1-1.2-0.1-2.5-0.5-3.7c-0.3-0.9-1-1.8-1.7-2.5 C99.4,218.1,98.5,218.7,97.9,219z M99.8,224.3c0,0.1,0,0.2,0,0.2c-0.4-0.8-0.9-1.6-1.8-2.2c0,0-0.1-0.3,0-0.7 c0.1-0.3,0.2-0.5,0.3-0.5l0.3-0.1c0.1,0,0.2-0.1,0.3-0.1c0.1,0,0.2-0.1,0.3-0.1c0.2,0.3,0.3,0.5,0.4,0.7 C99.7,222.4,99.9,223.4,99.8,224.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M167.6,189.3c-0.1-2.1-0.2-4.1-0.3-6c0-0.4-0.2-1-0.4-1.1c-2.3-1.1-4.5-2-6.8-3c-0.7,1.3-1.2,2.4-1.8,3.6 c-0.6,1.1-1.4,2.3-2,3.4C156.9,186.9,166.5,189.6,167.6,189.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M124.5,196c0-1-0.7-1.1-1.3-1.4c-1.3-0.6-2.6-0.1-3.8,0.2c-1,0.2-1.9,0.8-1.8,1.9c0.1,0.6,0.7,1.4,1.3,1.7 c2.7,1.5,5.4,1.6,8.5-0.2c-0.9-0.7-1.7-1.2-2.4-1.7C124.8,196.3,124.5,196.1,124.5,196z M119.9,196.6c0.3-0.1,0.5-0.1,0.8-0.2 c0.7-0.2,1.3-0.3,1.7-0.1c0.1,0,0.2,0.1,0.3,0.1c0.1,0.4,0.3,0.7,0.5,1C122,197.5,121,197.2,119.9,196.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M109.6,198.2c-0.2-0.1-0.6,0.1-0.7,0.3c-0.2,0.2-0.4,0.5-0.5,0.8c-0.7,1.3-1.4,2.6-2.2,3.9 c-1.4,2.2-3.2,3.7-5.9,4.4c-3,0.8-7.3-0.4-8.9-3.3c-1.4-2.5-2.7-5.1-4.1-7.6c-0.9,0.8-1.1-0.5-1.7-0.9c-0.1,0.1-0.3,0.1-0.4,0.2 c0.2,1,0.2,2.1,0.7,3c1.2,2.4,2.5,4.8,3.9,7.1c1.2,2.1,3.1,3.6,5.2,4.4c1.5,0.6,3.4,0.5,5.1,0.6c0.4,0,0.8-0.3,1.2-0.5 c0.8-0.4,1.7-0.8,2.5-1.3c0.7-0.4,1.5-0.7,2.1-1.3c2.6-2.4,4-5.5,4.2-9C110,198.7,109.8,198.3,109.6,198.2z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M106.8,178.4c-1.5-2.6-3-5.3-5.4-7.2c-0.5-0.4-0.8-0.9-1.3-1.2c-1.6-0.8-3.3-1.5-4.9-2.2 c-1-0.5-2-1.3-3.1-1.6c-2.3-0.6-4.8-0.9-7.1-1.3c-0.5-0.1-1.1-0.3-1.6-0.4c-1.5-0.3-3-0.6-4.6-0.8c-1.1-0.2-2.4,0-3.4-0.4 c-2-0.8-3.8-1.9-5.7-2.9c-0.6-0.3-1.1-0.6-1.6-0.9c-0.1,0.1-0.2,0.2-0.3,0.3c0.2,0.3,0.3,0.7,0.5,0.9c0.7,0.6,1.6,1.1,2.2,1.8 c1.6,2.3,4.5,1.9,6.4,3.6c0.1,0.1,0.4,0.1,0.6,0.1c2.2,0.2,4.4,0.2,6.6,0.5c1.9,0.3,3.8,0.7,5.5,1.3c2.8,1.1,5.5,2.4,8.3,3.7 c0.9,0.5,1.9,1,2.7,1.7c1.1,0.9,2.2,1.8,3.1,2.8c1.6,2,4,3.5,4.2,6.7c0.1,1.7,0.9,3.2,0.8,5.1c-0.2,2.5,0.4,5,0.7,7.5 c0,0.3,0.4,0.6,0.6,0.8c0.2-0.3,0.5-0.6,0.5-0.9c0.1-1.9,0.3-3.7-0.1-5.7C109.4,185.8,108.8,181.9,106.8,178.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M185.5,202.7c-0.7-0.3-1.2-0.6-1.7-0.6c-0.5,0-1,0.4-1.5,0.7c0.3,0.6,0.5,1.7,0.9,1.8 c0.6,0.1,1.3-0.4,1.9-0.8C185.3,203.7,185.4,203.1,185.5,202.7z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M120.5,137.6c0.1,0.4,0.7,0.8,1.1,0.8c2.6,0.1,4.8-0.3,6.5-2.7c1.2-1.6,1.7-3.2,1.2-5.1 c-0.5-2-2-3.2-3.4-4.1c-3,3.4-3.7,0.5-4.7-1.4c-0.3-0.5-1.1,0-1.1,0.9c0,0.6,0,1.2,0,1.7c0,2.3,0,4.5,0,6.8c0,0,0,0-0.1,0 C120.2,135.6,120.2,136.6,120.5,137.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M109.9,113.3c-0.2,0.1-0.4,0.1-0.6,0.1c-1.7,0.2-2.4,1.5-3.4,3.1c1.7,0,3.1,0.2,4.5,0.1 c1.5-0.2,1.8-0.9,1.5-2.5C111.6,112.7,110.8,112.9,109.9,113.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M191.7,178c0.5,0.3,1.1,0.7,1.6,0.6c1-0.2,1.7-0.8,2-1.9c0.1-0.5,0.4-1.1,0.6-1.6c0.9-1.6,0.4-2.4-1.9-2.4 c-1,0.3-2.6,0.7-4.1,1.3c-1,0.4-0.9,1.6-0.1,2.3C190.5,176.8,191,177.5,191.7,178z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M226.3,171.1c-0.2-1.8-0.4-3.6-0.4-5.4c0-0.9-0.4-1.2-1.1-1.2c-2.3,0-4.6-0.1-6.9,0 c-2.1,0.1-4.3,0.3-6.4,0.5c-1.7,0.1-3.5,0.2-5.2,0.5c-1.4,0.3-2.7,0.7-4-0.2c-0.1-0.1-0.3,0-0.5,0c-2.5,0.2-5.1,0.4-7.6,0.5 c-1,0-1.7-0.6-1.8-1.6c-0.3-3.2-0.5-6.5-0.7-9.8c-0.1-2.4-0.1-4.9-0.3-7.3c-0.2-2.6-0.5-5.1-0.7-7.6c-0.2-2.9-0.3-5.9-0.5-8.8 c0-0.3-0.4-0.9-0.7-0.9c-1.9,0-3.9,0-5.8,0.2c-1.3,0.1-2.6,0-3.5-1c-1.3-1.3-2.4-2.7-3.6-4c-0.3-0.4-0.5-1-0.7-1.6 c-0.4-1.3-0.8-2.7-1.1-4c-0.1-0.3-0.1-0.5-0.1-0.8c-0.1,0-0.3-0.1-0.4-0.1c-0.5,2.3-1.8,4.1-3.8,5.3c1.8,1,1.5,2.8,2,4.2 c0.1,0.3-0.3,0.8-0.4,1.1c-0.3-0.3-0.8-0.5-0.9-0.9c-0.5-1.4-0.9-2.8-1.3-4.2c-0.3,0-0.6,0.1-1,0.1c-0.9,0-1.1,0.6-1.1,1.4 c0.2,4.4,0.4,8.8,0.6,13.2c0.1,2.5,0.1,5.1,0.3,7.6c0.2,3.8,0.5,7.6,0.7,11.4c0.1,3.1,0.1,6.1,0,9.2c-0.1,2.7-0.3,5.3-0.5,8 c-0.1,0.8,0.3,1.1,1.1,1.1c3.3,0.2,6.5,0.4,9.8,0.8c1.5,0.2,3,0.4,4.3,1c0.9,0.4,1.3,0.3,1.7-0.4c0.5-0.9,1.1-1.8,1.4-2.8 c0.5-1.9,1.8-2.6,3.5-3c0.6-0.1,1.2-0.4,1.6-0.6c-0.6-1.7-1.5-3-0.8-4.8c0.5,0.5,0.7,1,1.1,1.5c0.4,0.5,0.9,0.8,1.4,1.3 c-0.3,0.5-0.6,1-0.9,1.5c0,0.1,0.1,0.2,0.1,0.4c1.3-0.2,2.6-0.3,3.9-0.5c1.4-0.3,1.9,0,1.8,1.5c0,1.2-0.1,2.5-0.2,3.7 c-0.1,1.9-0.9,3.3-2.6,4.2c-1.5,0.8-2.9,1.7-4.4,2.5c1.1,1.6,2.1,3,3.1,4.5c0.4,0.5,0.7,1.3,1.2,1.5c0.8,0.3,1.7,0.4,2.6,0.4 c1.8-0.1,3.6-0.4,5.5-0.6c2.9-0.2,5.8-0.4,8.7-0.6c1-0.1,2.1,0.1,3.1,0c3.2-0.4,6.5-0.8,9.7-1.3c0.3,0,0.8-0.6,0.8-0.9 c0.1-2.6,0.2-5.3,0.2-7.9C226.7,175.1,226.4,173.1,226.3,171.1z M201.5,169.8c0.6-0.7,1.4-1.3,2.2-1.9c0.2-0.1,0.6,0.3,0.8,0.4 c0,1.1-1.7,2.8-2.4,2.7C201.3,171,201,170.4,201.5,169.8z M202.3,177.1c-0.2,0-0.5-0.4-0.5-0.7c0-0.2,0.2-0.6,0.5-0.7 c0.9-0.5,2.8,0.1,3.5,1.4C204.6,177.1,203.4,177.2,202.3,177.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M174.6,192.5c2.5,3.4,5.9,3.3,9.4,2.9c1.3-0.1,2.9-1.5,3.3-3.1C183.1,191.8,178.9,191.1,174.6,192.5z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M179,184.6c-1.6-0.7-3.4-0.9-5.2-1.4c-1-0.3-2.1-0.5-3.1-0.7c-0.9-0.2-1.3,0.1-1.2,1.1 c0.2,1.7,0.4,3.4,0.5,5.1c0,1,0.5,1.4,1.4,1.4c1.3,0,2.6,0,3.9-0.2c3.2-0.4,6.4-0.7,9.6-0.3c0.7,0.1,1.5-0.1,2.2-0.2 c0-0.1,0-0.3,0.1-0.4c-0.4-0.4-0.8-0.8-1.3-1.1C183.6,186.9,181.3,185.6,179,184.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M192.8,187.1c-0.7-0.9-1.5-1.8-2.3-2.6c-2-2.2-4.6-3.5-7.4-4.4c-1.4-0.4-2.8-0.7-4.2-0.9c-1-0.1-2,0-3-0.2 c-1.1-0.1-2.2-0.6-3.3-0.6c-4.3-0.2-7.7-2.4-11.5-4.3c-0.8,1.3-0.8,2.9,0.2,3.4c2,1,4,1.9,6.2,2.6c2.7,0.8,5.4,1.1,8.1,1.7 c1.3,0.3,2.6,0.7,3.9,1c1,0.3,2.1,0.5,3,0.9c1.5,0.8,2.9,1.9,4.4,2.7c2.5,1.2,3.7,3,3.4,5.7c-0.1,1-0.4,2-0.6,3 c-0.1-0.1-0.2-0.2-0.2-0.3c-1.1,0.7-2.1,1.3-3.2,2c-0.4,0.2-0.7,0.6-1.1,0.6c-1.8,0.1-3.6,0.3-5.5,0.2c-1.1,0-2.2-0.4-3.2-0.8 c-1-0.4-1.8-1.2-2.8-1.5c-1.1-0.3-1.8-1-2.2-2c-0.1-0.3-0.3-0.7-0.6-0.7c-1.5-0.4-3-0.7-4.6-1c0.4,0.7,0.7,1.4,1.1,1.9 c1.8,1.7,3.6,3.3,5.5,4.9c1.9,1.6,4.1,2.4,6.5,2.2c0.8-0.1,1.7-0.4,2.5-0.6c1.8-0.5,3.7-0.6,5.3-1.5c1.7-0.9,3-2.4,4.6-3.6 c2-1.6,1.9-3.7,1.7-5.9C193.5,188.3,193.2,187.6,192.8,187.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M185.9,206c-0.6,0.2-1.1,0.5-1.6,0.8c-0.9,0.6-0.9,2.5-0.1,3.2c0.4,0.3,1.1,0.6,1.1,1 c0.3,1.3,1.2,1.7,2.1,2.2c0.5-0.9,1.2-1.7,1.4-2.6c0.2-1-0.1-2.1-0.3-3.2C188.2,205.9,187.3,205.5,185.9,206z M185.7,208.6 C185.7,208.6,185.6,208.6,185.7,208.6c-0.1-0.1-0.1-0.2-0.1-0.3c0.3-0.2,0.6-0.3,1-0.5c0.1,0.6,0.3,1.3,0.3,1.8 C186.5,209.2,186,208.8,185.7,208.6z"})
            )
          ), 
          React.createElement("g", {id: "Light_7"}, 
            React.createElement("g", null, 
              React.createElement("path", {fill: "#FFFFFF", d: "M67.4,200.8c-0.8-0.9-2-1.1-3.1-0.6c-1.1,0.5-2.2,1.2-3.4,2.1c-1,0.8-1.3,2.4-1,3.4 c0.3,1.1,1.3,1.5,1.8,1.7c0.3,0.1,0.6,0.2,0.9,0.2c0,0,0.1,0,0.1,0c2.7,0,5.2-2,5.4-4.5C68.3,202.3,68,201.4,67.4,200.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M63.5,198.3c0.2,0.1,0.4,0.2,0.6,0.3c0.3,0.2,0.6,0.2,0.9,0.2c0,0,0.1,0,0.1,0c2.7-0.1,3.7-1.9,3.7-3.4 c0-1.4-0.9-3-3.3-3.3c-0.1,0-0.2-0.1-0.3-0.1c-0.4-0.1-0.8-0.3-1.5-0.3c-0.7,0-2.3,0.1-3,1.5c-0.7,1.2-0.3,3.1,0.7,3.9 C62.2,197.7,62.9,198,63.5,198.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M73.5,205.3c-0.2-0.4-0.7-1.3-1.8-1.5c-1.1-0.3-2.5,0.3-3.1,1.3c-0.5,0.8-1.1,1.8-1.4,3 c-0.3,1.3,0.6,2.9,1.6,3.5c0.3,0.2,0.7,0.3,1.1,0.3c0.8,0,2.3-0.5,2.9-1.7c0.3-0.8,0.5-1.5,0.7-2.3c0.1-0.3,0.1-0.6,0.2-0.9 C74,206.5,73.9,205.9,73.5,205.3L73.5,205.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M70.2,199.6c1.5,1,3,2.1,5.1,1.5c1.8-0.5,2.6-1.2,2.5-3.1c0-0.7-0.1-1.4-0.2-2.1c-0.1-0.8-1-1.5-1.8-1.2 c-0.8,0.3-1.6,0.7-2.2,1.2C72.5,197.1,71.4,198.3,70.2,199.6z"}), 
              React.createElement("path", {d: "M62.7,205.7c-0.1-0.1-0.7-0.2-0.8-0.5c-0.1-0.4,0-1.1,0.3-1.3c0.9-0.7,1.9-1.4,3-1.9c0.7-0.3,1.1,0.3,1,0.9 C66,204.4,64.4,205.7,62.7,205.7z"}), 
              React.createElement("path", {d: "M65.1,196.9c-0.8-0.4-1.6-0.8-2.3-1.3c-0.3-0.2-0.4-1-0.2-1.4c0.2-0.3,0.9-0.4,1.3-0.4c0.5,0,1,0.3,1.5,0.4 c0.8,0.1,1.6,0.4,1.6,1.3C66.9,196.4,66.2,196.8,65.1,196.9z"}), 
              React.createElement("path", {d: "M71.9,206.6c-0.3,1.1-0.4,2-0.8,2.8c-0.1,0.3-1,0.6-1.2,0.5c-0.4-0.2-0.8-0.9-0.7-1.3c0.2-0.8,0.7-1.6,1.1-2.4 c0.2-0.3,0.7-0.5,1-0.4C71.5,205.8,71.7,206.3,71.9,206.6z"})
            )
          ), 
          React.createElement("g", {id: "Light_6"}, 
            React.createElement("g", null, 
              React.createElement("path", {fill: "#FFFFFF", d: "M292.8,163.8c-0.1-0.1-0.1-0.2-0.2-0.3c-0.2-0.3-0.6-0.8-1.1-1.2c-0.4-0.3-1.4-0.9-2.5-0.9 c-0.8,0-2.4,0.4-3,1.7c-0.2,0.4-0.3,0.9-0.2,1.4c0,0,0,0,0,0c-0.3-0.5-0.8-0.8-1.4-0.9c-0.6-0.1-1.1,0.1-1.6,0.5l-0.2,0.2 c-0.1-0.4-0.4-0.7-0.7-0.9c-0.5-0.4-1.1-0.5-1.6-0.4c-0.3,0-0.8,0.1-1.3,0.4c-2.2,1.3-2,3.6-1.9,4.5c0,0.2,0,0.4,0,0.5 c0,0.4,0,0.8,0.1,1.3l0,0.1c0.3,2.4,1.9,2.7,2.6,2.7c0.2,0,0.4,0,0.7-0.1c0.5-0.1,1.5-0.5,2-1.6c0.4,0.4,0.8,0.7,1.1,0.8 c0.1,0,0.1,0.1,0.2,0.1c0.3,0.3,0.8,0.4,1.2,0.4c0.2,0,0.4,0,0.6-0.1c0.6-0.2,1.1-0.7,1.3-1.3c0-0.1,0.1-0.2,0.1-0.3 c0.2-0.5,0.4-1.1,0.3-1.8c0-0.7-0.2-1.3-0.3-1.8c0,0,0.1,0.1,0.1,0.1c0.7,0.5,1.4,0.6,2,0.8c0.2,0,0.4,0.1,0.6,0.1 c0.2,0.1,0.4,0.1,0.6,0.1c0.4,0,0.9-0.1,1.2-0.4l1.1-0.8c0.4-0.3,0.7-0.8,0.8-1.3C293.3,164.8,293.2,164.2,292.8,163.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M276.5,152.2c0,2.8,0.7,4,3.2,5.7c1.9,1.3,2,1.3,2.3-0.9c0.2-1.5,1-3.4-0.9-4.5c-0.1-0.1-0.1-0.3-0.1-0.5 c-0.2-1.3-1.2-2.2-2.4-2.1C277,149.9,276.5,150.6,276.5,152.2z"}), 
              React.createElement("path", {d: "M279,167.7c-0.1-0.9-0.2-2,0.9-2.6c0.2-0.1,0.5-0.1,0.8-0.2c0,0.3,0,0.5,0,0.8c0,1.1-0.1,2.2,0,3.3c0.1,0.7,0,1.3-0.7,1.4 c-0.8,0.2-0.8-0.6-0.9-1.1C279.1,168.9,279.1,168.4,279,167.7z"}), 
              React.createElement("path", {d: "M283,166.5c0.3-0.3,0.7-0.6,1.1-0.9c0.2,0.3,0.5,0.6,0.6,1c0.2,0.7,0.4,1.4,0.5,2.1c0,0.5-0.2,1-0.4,1.5 c-0.4-0.3-0.9-0.5-1.1-0.9C283.4,168.6,283.3,167.7,283,166.5z"}), 
              React.createElement("path", {d: "M290.2,165.9c-0.8-0.2-1.5-0.3-2-0.6c-0.3-0.2-0.5-1-0.4-1.3c0.1-0.3,0.8-0.5,1.2-0.5c0.4,0,0.9,0.2,1.3,0.5 c0.4,0.3,0.6,0.7,0.9,1.1C290.9,165.4,290.5,165.6,290.2,165.9z"})
            )
          ), 
          React.createElement("g", {id: "Light_5"}, 
            React.createElement("g", null, 
              React.createElement("path", {fill: "#FFFFFF", d: "M427,177.3c1-1.1,1.7-3.5,1.5-4.6c-0.3-2.6-1.7-3.9-4.3-4.2c-0.1,0.2-0.2,0.5-0.4,0.7 c-1.1,1.2-1.1,2.5-0.2,3.8c0.3,0.5,0.6,0.8,1.4,0.6c0.5-0.1,1.1,0.3,1.7,0.5c0,0.1,0,0.3-0.1,0.4c-0.4,0.1-0.8,0.2-1.3,0.4 C425.9,175.7,426.4,176.4,427,177.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M434.4,190.4c-1.1,0-1.9-0.8-2.2-1c-1.5-1.5-2.5-3.1-3-5c-0.8-2.8,1.1-3.9,1.7-4.1 c0.4-0.2,0.8-0.3,1.3-0.3c1.3,0,2.3,0.8,2.9,2.3c0.3,0.7,0.6,1.3,0.9,2c0.2,0.4,0.4,0.8,0.5,1.2c0.1,0.3,0.2,0.6,0.4,0.9l0.2,0.4 c0.2,0.6,0.2,1.3-0.2,1.8c0,0.1-0.1,0.1-0.1,0.2c-0.2,0.4-0.5,1-1.2,1.4C435.2,190.3,434.8,190.4,434.4,190.4z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M429,191.8c-1.4,0-2.5-1.1-2.8-2.7c-0.3-1.5-0.4-2.7-0.5-3.9c-0.1-2,1.1-3.5,3.2-3.8c0.8-0.1,1.6,0.3,2,1 c0,0,0.1,0.1,0.1,0.1c0.2,0.3,0.6,0.8,0.7,1.5l0.1,0.3c0.3,1.1,0.5,2.4,0.6,3.7c0,1.3-0.8,2.7-1.9,3.4 C429.9,191.7,429.4,191.8,429,191.8z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M424.2,189.4c-0.7,0-1.4-0.3-1.9-0.8c-0.5-0.6-0.8-1.4-0.7-2.3c0.1-1,0.2-2.1,0.6-3.2 c0.3-0.9,0.9-1.4,1.4-1.7c0.1-0.1,0.2-0.1,0.2-0.2c0.5-0.4,1.1-0.6,1.7-0.5c0.6,0.1,1.2,0.5,1.5,1l0.2,0.4 c0.2,0.4,0.4,0.8,0.6,1.1c0.1,0.2,0.1,0.4,0.2,0.5c0.4,0.6,0.4,1.4,0.1,2.1c-0.1,0.2-0.2,0.4-0.3,0.7c-0.3,0.7-0.7,1.4-1.4,2.1 C425.7,189.1,425,189.4,424.2,189.4z"}), 
              React.createElement("path", {d: "M435.1,187.5c-0.2,0.3-0.4,0.8-0.7,0.9c-0.1,0.1-0.6-0.2-0.8-0.4c-1.2-1.2-2-2.5-2.5-4.1c-0.2-0.8-0.2-1.4,0.6-1.8 c0.8-0.4,1.2,0.2,1.5,0.9c0.4,1.1,1,2.2,1.4,3.2C434.8,186.6,435,187,435.1,187.5z"}), 
              React.createElement("path", {d: "M429.1,183.4c0.2,0.3,0.5,0.7,0.6,1.1c0.3,1.2,0.6,2.4,0.6,3.5c0,0.6-0.5,1.4-1,1.7c-0.7,0.4-1.1-0.3-1.2-0.9 c-0.2-1.2-0.4-2.5-0.5-3.7C427.6,184.2,427.9,183.5,429.1,183.4z"}), 
              React.createElement("path", {d: "M426.2,184.8c-0.5,0.8-0.8,1.7-1.4,2.3c-0.6,0.6-1.3,0.2-1.2-0.7c0.1-0.9,0.2-1.9,0.5-2.7c0.1-0.4,0.7-0.7,1.1-1.1 c0.2,0.5,0.5,0.9,0.7,1.4c0.1,0.2,0,0.4,0,0.6C426,184.7,426.1,184.7,426.2,184.8z"})
            )
          ), 
          React.createElement("g", {id: "Light_4"}, 
            React.createElement("g", null, 
              React.createElement("path", {d: "M529.7,103.1c-0.5,1-0.9,2-1.4,2.9c-0.2,0.3-0.9,0.5-1.1,0.3c-0.3-0.2-0.6-0.8-0.5-1.2c0.3-0.9,0.6-1.8,1.1-2.7 c0.2-0.3,0.8-0.7,1-0.7C529.2,102,529.4,102.6,529.7,103.1z"}), 
              React.createElement("path", {d: "M519.2,109c-0.4,0.6-0.6,1.1-1,1.2c-0.3,0.1-0.8-0.2-1-0.5c-0.5-0.7-0.8-1.5-1.1-2.2c-0.1-0.3,0.2-0.8,0.5-1.1 c0.1-0.1,0.7,0.1,0.9,0.3C518.1,107.3,518.6,108.1,519.2,109z"}), 
              React.createElement("path", {d: "M519.7,104.9c-0.4-0.6-1-1.2-1.3-1.9c-0.1-0.4,0.4-1.1,0.6-1.6c0,0,0.2-0.1,0.2,0c0.5,0.7,1.1,1.3,1.4,2.1 c0.1,0.3-0.3,0.8-0.5,1.3C520.2,104.8,520,104.8,519.7,104.9z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M522.7,108.3c-0.5,1.3-0.7,2.6-1.5,3.5c-1.1,1.3-1,2.3-0.3,3.6c0.4,0.8,1.9,1.3,2.3,0.7 c1.2-1.7,1.9-3.6,1.3-5.7C524.1,109.5,523.5,108.7,522.7,108.3z"})
            )
          ), 
          React.createElement("g", {id: "Light_3"}, 
            React.createElement("g", null, 
              React.createElement("path", {fill: "#FFFFFF", d: "M647,79.1c-0.4,0-0.8-0.1-1.1-0.2c-1.5-0.7-1.9-1.7-2-2.4c-0.1-0.6,0-1.7,1.3-2.6c1.2-0.9,2.4-1.7,3.7-2.4 c1.2-0.7,2.8-0.4,3.8,0.6c0.6,0.6,0.9,1.4,0.8,2.3C653.3,76.6,648.9,79.1,647,79.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M652.4,81.6c-0.2,0-0.4,0-0.5-0.1c-0.1,0-0.3-0.1-0.4-0.1c-0.4-0.1-0.9-0.2-1.4-0.5 c-1-0.6-1.9-1.8-1.5-3.1c0.3-0.9,1.1-1.8,2-2.1c1.3-0.5,2.4-0.8,3.5-1.1c0.7-0.1,1.5,0,2,0.1c0.1,0,0.2,0.1,0.3,0.1 c0.6,0.1,1.1,0.5,1.4,1c0.3,0.5,0.4,1.1,0.1,1.7c0,0.1-0.1,0.2-0.1,0.3c-0.1,0.6-0.4,1.6-1.3,2.2c-0.8,0.5-1.7,0.8-2.5,1.1 c-0.3,0.1-0.5,0.2-0.7,0.3C653,81.5,652.7,81.6,652.4,81.6z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M650.1,90.1C650.1,90.1,650,90.1,650.1,90.1c-1.4,0-2.9-0.8-3.7-1.9c-0.6-0.8-0.8-1.7-0.6-2.6 c0.3-1.1,1.7-2.4,2.9-2.4c0.5,0,0.9,0.2,1.3,0.5c0.7,0.6,1.3,1.2,1.9,1.8l0.4,0.4c0.4,0.4,0.6,0.9,0.6,1.4s-0.2,1.1-0.6,1.4 l-0.8,0.8C651.1,89.9,650.6,90.1,650.1,90.1z"}), 
              React.createElement("path", {d: "M651.5,74.1c-0.1,1-3.8,3.4-4.8,2.9c-1-0.4-1.1-1-0.3-1.6c1.1-0.8,2.3-1.6,3.5-2.3C650.7,72.7,651.5,73.3,651.5,74.1z"}), 
              React.createElement("path", {d: "M652.4,79.6c-0.6-0.2-0.9-0.2-1.2-0.4c-0.3-0.2-0.7-0.6-0.7-0.8c0.1-0.4,0.5-0.8,0.8-0.9c1-0.4,2.1-0.7,3.1-1 c0.5-0.1,1,0.1,1.5,0.2c-0.2,0.5-0.2,1.2-0.6,1.4C654.5,78.8,653.4,79.2,652.4,79.6z"}), 
              React.createElement("path", {d: "M650.1,88.1c-1.3,0-2.6-1.3-2.4-2c0.1-0.4,0.9-1,1-0.9c0.8,0.6,1.5,1.4,2.2,2.1C650.6,87.6,650.2,87.9,650.1,88.1z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M645.5,80.4c-1.6-0.3-3-0.5-4.5-0.7c-1-0.1-2-0.2-3-0.3c-0.8,0-2,2.1-1.6,2.8c0.1,0.1,0.2,0.3,0.3,0.3 c2.2,0.8,4.5,1.2,6.7,0C644.3,82.1,645.4,81.6,645.5,80.4z"})
            )
          ), 
          React.createElement("g", {id: "Light_2"}, 
            React.createElement("g", null, 
              React.createElement("path", {fill: "#FFFFFF", d: "M359.5,76c0-0.1,0.1-0.2,0.1-0.4c1.4,0.4,2.1-0.4,2.2-1.6c0.1-1.4-0.1-2.7-0.2-4.1c0-0.1-0.7-0.3-0.9-0.2 c-0.8,0.4-1.5,0.9-2.2,1.4c-0.7,0.5-1.4,3-0.9,3.7C358,75.4,358.8,75.6,359.5,76z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M362.9,61.3c-1.1,0-1.7-0.8-2-1.3c0-0.1-0.1-0.1-0.1-0.2c-0.4-0.5-0.5-1.1-0.4-1.7 c0.1-0.4,0.2-0.8,0.3-1.1c0.2-1.1,0.5-2.1,0.8-3.1c0.3-1,1.2-1.5,1.7-1.7c0.1,0,0.1-0.1,0.2-0.1c1-0.5,2.2-0.3,2.8,0.7 c0,0,0.1,0.1,0.1,0.2c0.3,0.4,0.9,1.2,0.7,2.2c-0.2,1.5-0.5,2.8-0.9,4c-0.4,1.3-1.7,1.7-2.5,2C363.4,61.2,363.2,61.3,362.9,61.3z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M366.1,68c-1.3,0-2.7-1.1-3-2.3c-0.4-1.6,0.6-3.1,1-3.7c0.9-1.2,2.2-1.9,3.3-1.9c1.2,0,2,0.9,2.3,1.3 c0,0,0,0,0,0c0.4,0.4,0.6,0.9,0.6,1.5C370.4,64.8,368.3,68,366.1,68C366.1,68,366.1,68,366.1,68z"}), 
              React.createElement("path", {fill: "#FFFFFF", d: "M356.7,65.6c-0.9,0-2-0.4-2.7-1.3c-1-1.4-1.2-3.1-0.5-4.7c0.5-1.1,1.5-1.8,2.6-1.8c1,0,1.9,0.6,2.4,1.5 c0.3,0.7,0.6,1.3,0.8,2c0.1,0.3,0.2,0.5,0.3,0.8c0.2,0.7,0.1,1.4-0.4,2c0,0-0.1,0.1-0.1,0.1c-0.3,0.4-0.8,1.2-1.9,1.4 C357,65.6,356.9,65.6,356.7,65.6z"}), 
              React.createElement("path", {d: "M362.4,58.6c0.3-1.5,0.6-2.8,1-4.1c0.1-0.3,0.6-0.4,1-0.7c0.2,0.4,0.6,0.8,0.6,1.1c-0.2,1.2-0.4,2.5-0.8,3.7 c-0.1,0.3-0.8,0.6-1.2,0.7C362.9,59.3,362.6,58.8,362.4,58.6z"}), 
              React.createElement("path", {d: "M368.4,62.9c0,1.2-1.5,3.2-2.2,3.2c-0.4,0-1-0.4-1.1-0.8c-0.3-1.1,1.3-3.2,2.4-3.2C367.8,62.1,368.2,62.7,368.4,62.9z"}), 
              React.createElement("path", {d: "M357.7,62.7c-0.3,0.3-0.5,0.8-0.8,0.9c-0.4,0.1-1-0.1-1.2-0.4c-0.6-0.8-0.7-1.8-0.3-2.8c0.3-0.7,1-0.8,1.3-0.2 C357.1,61,357.3,61.8,357.7,62.7z"})
            )
          ), 
          React.createElement("g", {id: "Light_1"}, 
            React.createElement("g", null, 
              React.createElement("path", {fill: "white", d: "M103.4,67.2c0.1-0.3,0.1-0.6,0.1-1l-0.2-0.9c-0.2-0.9-0.3-1.8-0.5-2.8c-0.2-0.9-1-1.4-1.3-1.7l-0.1-0.1 c-0.4-0.4-1-0.5-1.5-0.5c-0.5,0.1-1,0.3-1.4,0.8l-0.1,0.2c-0.2,0.2-0.4,0.5-0.6,0.9c-0.5,0.9-0.6,1.7-0.6,2.5 c-0.2-0.1-0.4-0.2-0.5-0.3l-0.1-0.1c-1-0.5-2.2-0.1-2.7,0.9c0,0-0.1,0.1-0.1,0.1c-0.3,0.4-0.7,1.2-0.5,2.2 c0.2,0.8,0.4,1.5,0.7,2.3l0.2,0.5c0.8,2.3,2.4,2.6,3.1,2.6c0.4,0,0.7-0.1,1.1-0.2c1.1-0.4,1.5-1.5,1.7-2.3c0-0.1,0.1-0.2,0.1-0.3 c0.2,0.1,0.4,0.1,0.6,0.1c0.1,0,0.1,0,0.2,0c1.6,0,2.3-1.6,2.5-1.9C103.4,68,103.4,67.5,103.4,67.2z"}), 
              React.createElement("path", {fill: "white", d: "M106.8,64.2c-1.9,0.6-3.8,3.3-3.8,5.5c0,0.4,0.1,0.7,0.3,1.1l0,0c0.2,0.5,0.8,1.5,2,1.8 c0.2,0,0.4,0.1,0.6,0.1c1.1,0,2.3-0.7,2.9-1.6c0.6-0.9,1-2,1.5-3.3c0.3-0.9,0.2-1.9-0.3-2.6C109.2,64.2,108,63.9,106.8,64.2z"}), 
              React.createElement("path", {fill: "white", d: "M101,74.7c-1.2,1.5-2.3,3.2-2.4,5.1c0,1.3,0.7,2.7,1.5,3.9c0.3,0.5,2.1,0.7,2.3,0.4c0.7-1,1.3-2.3,1.4-3.5 C103.9,78.3,103.3,76.2,101,74.7z"}), 
              React.createElement("path", {d: "M101.4,66.6c0,0.3,0,0.7-0.1,1c-0.1,0.3-0.5,0.7-0.7,0.7c-0.3,0-0.7-0.3-0.9-0.6c-0.6-1.5-1.2-2.9-0.3-4.5 c0.2-0.3,0.4-0.5,0.6-0.8c0.3,0.2,0.7,0.4,0.8,0.7C101.1,64.2,101.3,65.4,101.4,66.6C101.5,66.6,101.4,66.6,101.4,66.6z"}), 
              React.createElement("path", {d: "M105,69.7c0-1.5,1.4-3.3,2.4-3.6c0.7-0.2,1.2,0.3,0.9,1c-0.3,1-0.7,2-1.3,2.9c-0.2,0.4-0.9,0.7-1.3,0.6 C105.3,70.6,105.1,69.9,105,69.7z"}), 
              React.createElement("path", {d: "M98.2,69.1c-0.3,0.7-0.4,1.6-0.8,1.8c-0.8,0.3-1.3-0.4-1.5-1.2c-0.3-0.8-0.6-1.7-0.8-2.5c-0.1-0.3,0.3-0.7,0.5-1 c0.3,0.2,0.6,0.2,0.8,0.5C96.9,67.4,97.5,68.3,98.2,69.1z"})
            )
          )
        ), 






        React.createElement("img", {className: "holiday", src: "/images/holiday.svg"}), 
        React.createElement("div", {className: "middle-content"}, 
          "Celebrate a successful year and set the scene for 2015 ", React.createElement("br", null), 
          "with the finest beer, whisky and Irish coffees in town", React.createElement("br", null), 
          "our favorite local restaurant fare", React.createElement("br", null), 
          "lively conversation & table games."
        ), 
         self.state.submitted ? 
          React.createElement("div", {className: "thanks"}, 
             self.state.guests == 'solo' ? React.createElement("h2", {className: "thanks-message"}, "Thanks, see you there. We’ll seat you at the rando table.") : '', 
             self.state.guests == 'plus1' ? React.createElement("h2", {className: "thanks-message"}, "Thanks, see you and your +1 there.") : '', 
             self.state.guests == 'posse' ? React.createElement("h2", {className: "thanks-message"}, "Thanks, see you and your small posse there.") : ''
          )
          :
          React.createElement("div", {className: "form"}, 
            React.createElement("div", {className: "form-row"}, 
              React.createElement("input", {placeholder: "First", onChange: self.handleFirst}), 
              React.createElement("input", {placeholder: "Last", onChange: self.handleLast})
            ), 
            React.createElement("div", {className: "form-row"}, 
              React.createElement("div", {className: "scribbles", autocomplete: "off"}, 
                React.createElement("ul", null, 
                  React.createElement("li", null, React.createElement("input", {id: "r1", name: "r1", type: "radio", value: "solo", onChange: self.handleGuest}), React.createElement("label", {for: "r1"}, "Going solo")), 
                  React.createElement("li", null, React.createElement("input", {id: "r2", name: "r1", type: "radio", value: "plus1", onChange: self.handleGuest}), React.createElement("label", {for: "r2"}, "Bringing a +1")), 
                  React.createElement("li", null, React.createElement("input", {id: "r3", name: "r1", type: "radio", value: "posse", onChange: self.handleGuest}), React.createElement("label", {for: "r3"}, "Rolling with a small posse"))
                )
              )
            ), 
            React.createElement("div", {className: "form-row"}, 
               (self.state.first.length > 0) && (self.state.last.length > 0) && (self.state.guests.length > 0) ? React.createElement("span", {className: "submit", onClick: self.submitContent}, "RSVP") : "", 
               (self.state.first.length > 0) && (self.state.last.length > 0) && (self.state.guests.length == 0) ? React.createElement("h3", {className: "instructions"}, "RSVP with # of guests") : "", 
               ((self.state.first.length == 0) || (self.state.last.length == 0)) && (self.state.guests.length > 0) ? React.createElement("h3", {className: "instructions"}, "RSVP with your name") : "", 
               ((self.state.first.length == 0) || (self.state.last.length == 0)) && (self.state.guests.length == 0) ? React.createElement("h3", {className: "instructions"}, "RSVP with your name and # of guests") : ""
            )
          ), 
        
        React.createElement("div", {className: "date"}, 
          "Monday, December 22, 2014", React.createElement("br", null), 
          "6-10pm"
        ), 
        React.createElement("div", {className: "location"}, 
          "Brickway Brewery & Distillery | 1116 Jackson Street, Omaha"
        ), 

        React.createElement("div", {className: "jonny"}, 
          React.createElement("img", {src: "/images/blkprty-jonny-1.svg"})
        ), 
        React.createElement("div", {className: "howard"}, 
          React.createElement("img", {src: "/images/blkprty-howie-1.svg"})
        )

      )
      
    )
  }
});



React.renderComponent(
  BLKPRTY(),
  document.getElementById('content')
)

require('./svgcheckbox.js');
},{"./svgcheckbox.js":151,"react":146,"superagent":147}],151:[function(require,module,exports){
if( document.createElement('svg').getAttributeNS ) {

	var radiobxsFill = Array.prototype.slice.call( document.querySelectorAll( '.scribbles input[type="radio"]' ) ),
			pathDefs = {
				fill : ['M15.833,24.334c2.179-0.443,4.766-3.995,6.545-5.359 c1.76-1.35,4.144-3.732,6.256-4.339c-3.983,3.844-6.504,9.556-10.047,13.827c-2.325,2.802-5.387,6.153-6.068,9.866 c2.081-0.474,4.484-2.502,6.425-3.488c5.708-2.897,11.316-6.804,16.608-10.418c4.812-3.287,11.13-7.53,13.935-12.905 c-0.759,3.059-3.364,6.421-4.943,9.203c-2.728,4.806-6.064,8.417-9.781,12.446c-6.895,7.477-15.107,14.109-20.779,22.608 c3.515-0.784,7.103-2.996,10.263-4.628c6.455-3.335,12.235-8.381,17.684-13.15c5.495-4.81,10.848-9.68,15.866-14.988 c1.905-2.016,4.178-4.42,5.556-6.838c0.051,1.256-0.604,2.542-1.03,3.672c-1.424,3.767-3.011,7.432-4.723,11.076 c-2.772,5.904-6.312,11.342-9.921,16.763c-3.167,4.757-7.082,8.94-10.854,13.205c-2.456,2.777-4.876,5.977-7.627,8.448 c9.341-7.52,18.965-14.629,27.924-22.656c4.995-4.474,9.557-9.075,13.586-14.446c1.443-1.924,2.427-4.939,3.74-6.56 c-0.446,3.322-2.183,6.878-3.312,10.032c-2.261,6.309-5.352,12.53-8.418,18.482c-3.46,6.719-8.134,12.698-11.954,19.203 c-0.725,1.234-1.833,2.451-2.265,3.77c2.347-0.48,4.812-3.199,7.028-4.286c4.144-2.033,7.787-4.938,11.184-8.072 c3.142-2.9,5.344-6.758,7.925-10.141c1.483-1.944,3.306-4.056,4.341-6.283c0.041,1.102-0.507,2.345-0.876,3.388 c-1.456,4.114-3.369,8.184-5.059,12.212c-1.503,3.583-3.421,7.001-5.277,10.411c-0.967,1.775-2.471,3.528-3.287,5.298 c2.49-1.163,5.229-3.906,7.212-5.828c2.094-2.028,5.027-4.716,6.33-7.335c-0.256,1.47-2.07,3.577-3.02,4.809'],
			},
			animDefs = {
				fill : { speed : .8, easing : 'ease-in-out' },
			};

	function createSVGEl( def ) {
		var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		if( def ) {
			svg.setAttributeNS( null, 'viewBox', def.viewBox );
			svg.setAttributeNS( null, 'preserveAspectRatio', def.preserveAspectRatio );
		}
		else {
			svg.setAttributeNS( null, 'viewBox', '0 0 100 100' );
		}
		svg.setAttribute( 'xmlns', 'http://www.w3.org/2000/svg' );
		return svg;
	}


	function controlRadiobox( el, type ) {
		var svg = createSVGEl();
		el.parentNode.appendChild( svg );
		el.addEventListener( 'change', function() {
			resetRadio( el );
			draw( el, type );
		});
	}

	radiobxsFill.forEach( function( el, i ) { controlRadiobox( el, 'fill' ); } );

	function draw( el, type ) {
		var paths = [], pathDef, 
			animDef,
			svg = el.parentNode.querySelector( 'svg' );

		switch( type ) {
			case 'fill': pathDef = pathDefs.fill; animDef = animDefs.fill; break;
		};
		
		paths.push( document.createElementNS('http://www.w3.org/2000/svg', 'path' ) );

		if( type === 'cross' || type === 'list' ) {
			paths.push( document.createElementNS('http://www.w3.org/2000/svg', 'path' ) );
		}
		
		for( var i = 0, len = paths.length; i < len; ++i ) {
			var path = paths[i];
			svg.appendChild( path );

			path.setAttributeNS( null, 'd', pathDef[i] );

			var length = path.getTotalLength();
			// Clear any previous transition
			//path.style.transition = path.style.WebkitTransition = path.style.MozTransition = 'none';
			// Set up the starting positions
			path.style.strokeDasharray = length + ' ' + length;
			if( i === 0 ) {
				path.style.strokeDashoffset = Math.floor( length ) - 1;
			}
			else path.style.strokeDashoffset = length;
			// Trigger a layout so styles are calculated & the browser
			// picks up the starting position before animating
			path.getBoundingClientRect();
			// Define our transition
			path.style.transition = path.style.WebkitTransition = path.style.MozTransition  = 'stroke-dashoffset ' + animDef.speed + 's ' + animDef.easing + ' ' + i * animDef.speed + 's';
			// Go!
			path.style.strokeDashoffset = '0';
		}
	}

	function reset( el ) {
		Array.prototype.slice.call( el.parentNode.querySelectorAll( 'svg > path' ) ).forEach( function( el ) { el.parentNode.removeChild( el ); } );
	}

	function resetRadio( el ) {
		Array.prototype.slice.call( document.querySelectorAll( 'input[type="radio"]' ) ).forEach( function( el ) { 
			var path = el.parentNode.querySelector( 'svg > path' );
			if( path ) {
				path.parentNode.removeChild( path );
			}
		} );
	}

}
},{}],152:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}]},{},[150]);
