/** Here is yet another implementation of XPath 1.0 in Javascript.
 * My goal is to make it relatively compact.
 */
(function() {
var core;
if ('function' === typeof require)
  core = require("../level2/core").dom.level2.core;
else
  core = this;
var exp;
if ('object' === typeof exports)
  exp = exports;
else
  exp = this;

// For unit tests:
exp.Stream = Stream;
exp.parse = parse;
exp.evaluateImpl = evaluateImpl;

/***************************************************************************
 *                            Tokenization                                 *
 ***************************************************************************/
/**
 * The XPath lexer is basically a single regular expression, along with
 * some helper functions to pop different types.
 */
function Stream(str) {
  this.original = this.str = str;
  this.peeked = null;
  // TODO: not really needed, but supposedly tokenizer also disambiguates
  // a * b vs. node test *
  this.prev = null;  // for debugging
  this.prevprev = null;
}
Stream.prototype = {
  peek: function() {
    if (this.peeked) return this.peeked;
    var m = this.re.exec(this.str);
    if (!m) return null;
    this.str = this.str.substr(m[0].length);
    return this.peeked = m[1];
  },
  /** Peek 2 tokens ahead. */
  peek2: function() {
    this.peek();  // make sure this.peeked is set
    var m = this.re.exec(this.str);
    if (!m) return null;
    return m[1];
  },
  pop: function() {
    var r = this.peek();
    this.peeked = null;
    this.prevprev = this.prev;
    this.prev = r;
    return r;
  },
  trypop: function(tokens) {
    var tok = this.peek();
    if (tok === tokens) return this.pop();
    if (Array.isArray(tokens)) {
      for (var i = 0; i < tokens.length; ++i) {
        var t = tokens[i];
        if (t == tok) return this.pop();;
      }
    }
  },
  trypopfuncname: function() {
    var tok = this.peek();
    switch (tok) {
      case 'comment': case 'text': case 'processing-instruction': case 'node':
        return null;
    }
    if ('(' != this.peek2()) return null;
    return this.pop();
  },
  trypopaxisname: function() {
    var tok = this.peek();
    switch (tok) {
      case 'ancestor': case 'ancestor-or-self': case 'attribute':
      case 'child': case 'descendant': case 'descendant-or-self':
      case 'following': case 'following-sibling': case 'namespace':
      case 'parent': case 'preceding': case 'preceding-sibling': case 'self':
        if ('::' == this.peek2()) return this.pop();
    }
    return null;
  },
  trypopnametest: function() {
    var tok = this.peek();
    if ('*' === tok || this.startsWithNcNameRe.test(tok)) return this.pop();
    return null;
  },
  trypopliteral: function() {
    var tok = this.peek();
    if (null == tok) return null;
    var first = tok.charAt(0);
    var last = tok.charAt(tok.length - 1);
    if ('"' === first && '"' === last ||
        "'" === first && "'" === last) {
      this.pop();
      return tok.substr(1, tok.length - 2);
    }
  },
  trypopnumber: function() {
    var tok = this.peek();
    if (this.isNumberRe.test(tok)) return parseFloat(this.pop());
    else return null;
  },
  trypopvarref: function() {
    var tok = this.peek();
    if (null == tok) return null;
    if ('$' === tok.charAt(0)) return this.pop().substr(1);
    else return null;
  },
  position: function() {
    return this.original.length - this.str.length;
  }
};
(function() {
  // http://www.w3.org/TR/REC-xml-names/#NT-NCName
  var nameStartCharsExceptColon =
      'A-Z_a-z\xc0-\xd6\xd8-\xf6\xF8-\u02FF\u0370-\u037D\u037F-\u1FFF' +
      '\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF' +
      '\uFDF0-\uFFFD';  // JS doesn't support [#x10000-#xEFFFF]
  var nameCharExceptColon = nameStartCharsExceptColon +
      '\\-\\.0-9\xb7\u0300-\u036F\u203F-\u2040';
  var ncNameChars = '[' + nameStartCharsExceptColon +
      '][' + nameCharExceptColon + ']*'
  // http://www.w3.org/TR/REC-xml-names/#NT-QName
  var qNameChars = ncNameChars + '(?::' + ncNameChars + ')?';
  var otherChars = '\\.\\.|[\\(\\)\\[\\].@,]|::';  // .. must come before [.]
  var operatorChars =
      'and|or|mod|div|' +
      '//|!=|<=|>=|[*/|+\\-=<>]';  // //, !=, <=, >= before individual ones.
  var literal = '"[^"]*"|' + "'[^']*'";
  var numberChars = '[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+';
  var variableReference = '\\$' + qNameChars;
  var nameTestChars = '\\*|' + ncNameChars + ':\\*|' + qNameChars;
  var optionalSpace = '[ \t\r\n]*';  // stricter than regexp \s.
  var nodeType = 'comment|text|processing-instruction|node';
  var re = new RegExp(
      // numberChars before otherChars so that leading-decimal doesn't become .
      '^' + optionalSpace + '(' + numberChars + '|' + otherChars + '|' +
      nameTestChars + '|' + operatorChars + '|' + literal + '|' +
      variableReference + ')'
      // operatorName | nodeType | functionName | axisName are lumped into
      // qName for now; we'll check them on pop.
  );
  Stream.prototype.re = re;
  Stream.prototype.startsWithNcNameRe = new RegExp('^' + ncNameChars);
  Stream.prototype.isNumberRe = new RegExp('^' + numberChars + '$');
})();

/***************************************************************************
 *                               Parsing                                   *
 ***************************************************************************/
function parseError(stream, m) {
  var pos = (stream.original.length - stream.str.length);
  var mess = 'pos ' + pos + ' (' + stream.prevprev + ' ' + stream.prev + ' ' + stream.peek() + '): ' + m;
  return new Error(mess);
}
function parse(stream, a) {
  var r = orExpr(stream,a);
  var x, unparsed = [];
  while (x = stream.pop()) {
    unparsed.push(x);
  }
  if (unparsed.length)
    throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                             'Position ' + stream.position() +
                             ': Unparsed tokens: ' + unparsed.join(' '));
  return r;
}

/**
 * binaryL  ::= subExpr
 *            | binaryL op subExpr
 * so a op b op c becomes ((a op b) op c)
 */
function binaryL(subExpr, stream, a, ops) {
  var lhs = subExpr(stream, a);
  if (lhs == null) return null;
  var op;
  while (op = stream.trypop(ops)) {
    var rhs = subExpr(stream, a);
    if (rhs == null)
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Expected something after ' + op);
    lhs = a.node(op, lhs, rhs);
  }
  return lhs;
}
/**
 * Too bad this is never used. If they made a ** operator (raise to power),
 ( we would use it.
 * binaryR  ::= subExpr
 *            | subExpr op binaryR
 * so a op b op c becomes (a op (b op c))
 */
function binaryR(subExpr, stream, a, ops) {
  var lhs = subExpr(stream, a);
  if (lhs == null) return null;
  var op = stream.trypop(ops);
  if (op) {
    var rhs = binaryR(stream, a);
    if (rhs == null)
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Expected something after ' + op);
    return a.node(op, lhs, rhs);
  } else {
    return lhs;// TODO
  }
}
/** [1] LocationPath::= RelativeLocationPath | AbsoluteLocationPath
 * e.g. a, a/b, //a/b
 */
function locationPath(stream, a) {
  return absoluteLocationPath(stream, a) || relativeLocationPath(null, stream, a);
}
/** [2] AbsoluteLocationPath::= '/' RelativeLocationPath? | AbbreviatedAbsoluteLocationPath
 *  [10] AbbreviatedAbsoluteLocationPath::= '//' RelativeLocationPath
 */
function absoluteLocationPath(stream, a) {
  var op = stream.peek();
  if ('/' === op || '//' === op) {
    var lhs = a.node('Root');
    return relativeLocationPath(lhs, stream, a, true);
  } else {
    return null;
  }
}
/** [3] RelativeLocationPath::= Step | RelativeLocationPath '/' Step |
 *                            | AbbreviatedRelativeLocationPath
 *  [11] AbbreviatedRelativeLocationPath::= RelativeLocationPath '//' Step
 * e.g. p/a, etc.
 */
function relativeLocationPath(lhs, stream, a, isOnlyRootOk) {
  if (null == lhs) {
    lhs = step(stream, a);
    if (null == lhs) return lhs;
  }
  var op;
  while (op = stream.trypop(['/', '//'])) {
    if ('//' === op) {
      lhs = a.node('/', lhs,
                   a.node('Axis', 'descendant-or-self', 'node', undefined));
    }
    var rhs = step(stream, a);
    if (null == rhs && '/' === op && isOnlyRootOk) return lhs;
    else isOnlyRootOk = false;
    if (null == rhs)
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Expected step after ' + op);
    lhs = a.node('/', lhs, rhs);
  }
  return lhs;
}
/** [4] Step::= AxisSpecifier NodeTest Predicate* | AbbreviatedStep
 *  [12] AbbreviatedStep::= '.' | '..'
 * e.g. @href, self::p, p, a[@href], ., ..
 */
function step(stream, a) {
  var abbrStep = stream.trypop(['.', '..']);
  if (null != abbrStep) return abbrStep;
  var axis = axisSpecifier(stream, a);
  var nodeType = nodeTypeTest(stream, a);
  var nodeName;
  if (null == nodeType) nodeName = nodeNameTest(stream, a);
  if (null == axis && null == nodeType && null == nodeName) return null;
  if (null == nodeType && null == nodeName)
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Expected nodeTest after axisSpecifier ' + axis);
  if (null == axis) axis = 'child';
  if (null == nodeType) {
    // When there's only a node name, then the node type is forced to be the
    // principal node type of the axis.
    // see http://www.w3.org/TR/xpath/#dt-principal-node-type
    if ('attribute' === axis) nodeType = 'attribute';
    else if ('namespace' === axis) nodeType = 'namespace';
    else nodeType = 'element';
  }
  var lhs = a.node('Axis', axis, nodeType, nodeName);
  var pred;
  while (null != (pred = predicate(lhs, stream, a))) {
    lhs = pred;
  }
  return lhs;
}
/** [5] AxisSpecifier::= AxisName '::' | AbbreviatedAxisSpecifier
 *  [6] AxisName::= 'ancestor' | 'ancestor-or-self' | 'attribute' | 'child'
 *                | 'descendant' | 'descendant-or-self' | 'following'
 *                | 'following-sibling' | 'namespace' | 'parent' |
 *                | 'preceding' | 'preceding-sibling' | 'self'
 *  [13] AbbreviatedAxisSpecifier::= '@'?
 */
function axisSpecifier(stream, a) {
  var attr = stream.trypop('@');
  if (null != attr) return 'attribute';
  var axisName = stream.trypopaxisname();
  if (null != axisName) {
    var coloncolon = stream.trypop('::');
    if (null == coloncolon)
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Should not happen. Should be ::.');
    return axisName;
  }
}
/** [7] NodeTest::= NameTest | NodeType '(' ')' | 'processing-instruction' '(' Literal ')'
 *  [38] NodeType::= 'comment' | 'text' | 'processing-instruction' | 'node'
 * I've split nodeTypeTest from nodeNameTest for convenience.
 */
function nodeTypeTest(stream, a) {
  if ('(' !== stream.peek2()) {
    return null;
  }
  var type = stream.trypop(['comment', 'text', 'processing-instruction', 'node']);
  if (null != type) {
    if (null == stream.trypop('('))
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Should not happen.');
    var param = undefined;
    if (type == 'processing-instruction') {
      param = stream.trypopliteral();
    }
    if (null == stream.trypop(')'))
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Expected close parens.');
    return type
  }
}
function nodeNameTest(stream, a) {
  var name = stream.trypopnametest();
  if (name != null) return name;
  else return null;
}
/** [8] Predicate::= '[' PredicateExpr ']'
 *  [9] PredicateExpr::= Expr
 */
function predicate(lhs, stream, a) {
  if (null == stream.trypop('[')) return null;
  var expr = orExpr(stream, a);
  if (null == expr)
    throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                             'Position ' + stream.position() +
                             ': Expected expression after [');
  if (null == stream.trypop(']'))
    throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                             'Position ' + stream.position() +
                             ': Expected ] after expression.');
  return a.node('Predicate', lhs, expr);
}
/** [14] Expr::= OrExpr
 */
/** [15] PrimaryExpr::= VariableReference | '(' Expr ')' | Literal | Number | FunctionCall
 * e.g. $x,  (3+4),  "hi",  32,  f(x)
 */
function primaryExpr(stream, a) {
  var x = stream.trypopliteral() ||
      stream.trypopnumber();
  if (null != x) return x;
  var varRef = stream.trypopvarref();
  if (null != varRef) return a.node('VariableReference', varRef);
  var funCall = functionCall(stream, a);
  if (null != funCall) return funCall;
  if (stream.trypop('(')) {
    var e = orExpr(stream, a);
    if (null == e)
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Expected expression after (.');
    if (null == stream.trypop(')'))
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Expected ) after expression.');
    return e;
  }
  return null;
}
/** [16] FunctionCall::= FunctionName '(' ( Argument ( ',' Argument )* )? ')'
 *  [17] Argument::= Expr
 */
function functionCall(stream, a) {
  var name = stream.trypopfuncname(stream, a);
  if (null == name) return null;
  if (null == stream.trypop('('))
    throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                             'Position ' + stream.position() +
                             ': Expected ( ) after function name.');
  var params = [];
  var first = true;
  while (null == stream.trypop(')')) {
    if (!first && null == stream.trypop(','))
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Expected , between arguments of the function.');
    first = false;
    var param = orExpr(stream, a);
    if (param == null)
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Expected expression as argument of function.');
    params.push(param);
  }
  return a.node('FunctionCall', name, params);
}

/** [18] UnionExpr::= PathExpr | UnionExpr '|' PathExpr
 */
function unionExpr(stream, a) { return binaryL(pathExpr, stream, a, '|'); }
/** [19] PathExpr ::= LocationPath
 *                  | FilterExpr
 *                  | FilterExpr '/' RelativeLocationPath
 *                  | FilterExpr '//' RelativeLocationPath
 * Unlike most other nodes, this one always generates a node because
 * at this point all reverse nodesets must turn into a forward nodeset
 */
function pathExpr(stream, a) {
  // We have to do FilterExpr before LocationPath because otherwise
  // LocationPath will eat up the name from a function call.
  var filter = filterExpr(stream, a);
  if (null == filter) return a.node('PathExpr', locationPath(stream, a));
  var rel = relativeLocationPath(filter, stream, a, false);
  if (filter === rel) return rel;
  else return a.node('PathExpr', rel);
}
/** [20] FilterExpr::= PrimaryExpr | FilterExpr Predicate
 * aka. FilterExpr ::= PrimaryExpr Predicate*
 */
function filterExpr(stream, a) {
  var primary = primaryExpr(stream, a);
  if (primary == null) return null;
  var pred, lhs = primary;
  while (null != (pred = predicate(lhs, stream, a))) {
    lhs = pred;
  }
  return lhs;
}

/** [21] OrExpr::= AndExpr | OrExpr 'or' AndExpr
 */
function orExpr(stream, a) {
  return binaryL(andExpr, stream, a, 'or');
}
/** [22] AndExpr::= EqualityExpr | AndExpr 'and' EqualityExpr
 */
function andExpr(stream, a) { return binaryL(equalityExpr, stream, a, 'and'); }
/** [23] EqualityExpr::= RelationalExpr | EqualityExpr '=' RelationalExpr
 *                     | EqualityExpr '!=' RelationalExpr
 */
function equalityExpr(stream, a) { return binaryL(relationalExpr, stream, a, ['=','!=']); }
/** [24] RelationalExpr::= AdditiveExpr | RelationalExpr '<' AdditiveExpr
 *                       | RelationalExpr '>' AdditiveExpr
 *                       | RelationalExpr '<=' AdditiveExpr
 *                       | RelationalExpr '>=' AdditiveExpr
 */
function relationalExpr(stream, a) { return binaryL(additiveExpr, stream, a, ['<','>','<=','>=']); }
/** [25] AdditiveExpr::= MultiplicativeExpr
 *                     | AdditiveExpr '+' MultiplicativeExpr
 *                     | AdditiveExpr '-' MultiplicativeExpr
 */
function additiveExpr(stream, a) { return binaryL(multiplicativeExpr, stream, a, ['+','-']); }
/** [26] MultiplicativeExpr::= UnaryExpr
 *                           | MultiplicativeExpr MultiplyOperator UnaryExpr
 *                           | MultiplicativeExpr 'div' UnaryExpr
 *                           | MultiplicativeExpr 'mod' UnaryExpr
 */
function multiplicativeExpr(stream, a) { return binaryL(unaryExpr, stream, a, ['*','div','mod']); }
/** [27] UnaryExpr::= UnionExpr | '-' UnaryExpr
 */
function unaryExpr(stream, a) {
  if (stream.trypop('-')) {
    var e = unaryExpr(stream, a);
    if (null == e)
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Expected unary expression after -');
    return a.node('UnaryMinus', e);
  }
  else return unionExpr(stream, a);
}
var astFactory = {
  node: function() {return Array.prototype.slice.call(arguments);},
  i: 0,
};


/***************************************************************************
 *                            Optimizations (TODO)                         *
 ***************************************************************************/
/**
 * Some things I've been considering:
 * 1) a//b becomes a/descendant::b if there's no predicate that uses
 *    position() or last()
 * 2) axis[pred]: when pred doesn't use position, evaluate it just once per
 *    node in the node-set rather than once per (node, position, last).
 * For more optimizations, look up Gecko's optimizer:
 * http://mxr.mozilla.org/mozilla-central/source/content/xslt/src/xpath/txXPathOptimizer.cpp
 */
// TODO
function optimize(ast) {
}

/***************************************************************************
 *                             Evaluation                                  *
 ***************************************************************************/

/**
 * Data types: For string, number, boolean, we just use Javascript types.
 * Node-sets have the form
 *    {nodes: [node, ...]}
 * or {nodes: [node, ...], pos: [[1], [2], ...], lasts: [[1], [2], ...]}
 */

/**
 * The NodeMultiSet basically saves a list of (node, position, last) tuples
 * which form the possible values of an axis. Most of the time, only the node
 * is used and the position information is discarded. But if you use a
 * predicate, we need to try every value of position and last in case the
 * predicate calls position() or last().
 */
function NodeMultiSet(isReverseAxis) {
  this.nodes = [];
  this.pos = [];
  this.lasts = [];
  this.nextPos = [];
  this.seriesIndexes = [];  // index within nodes that each series begins.
  this.isReverseAxis = isReverseAxis;
  this._pushToNodes = isReverseAxis ? Array.prototype.unshift : Array.prototype.push;
}
NodeMultiSet.prototype = {
  pushSeries: function pushSeries() {
    this.nextPos.push(1);
    this.seriesIndexes.push(this.nodes.length);
  },
  popSeries: function popSeries() {
    console.assert(0 < this.nextPos.length, this.nextPos);
    var last = this.nextPos.pop() - 1,
        indexInPos = this.nextPos.length,
        seriesBeginIndex = this.seriesIndexes.pop(),
        seriesEndIndex = this.nodes.length;
    for (var i = seriesBeginIndex; i < seriesEndIndex; ++i) {
      console.assert(indexInPos < this.lasts[i].length);
      console.assert(undefined === this.lasts[i][indexInPos]);
      this.lasts[i][indexInPos] = last;
    }
  },
  finalize: function() {
    if (null == this.nextPos) return;
    console.assert(0 === this.nextPos.length);
    for (var i = 0; i < this.lasts.length; ++i) {
      for (var j = 0; j < this.lasts[i].length; ++j) {
        console.assert(null != this.lasts[i][j], i + ',' + j + ':' + JSON.stringify(this.lasts));
      }
    }
    this.pushSeries = this.popSeries = this.addNode = function() {
      throw new Error('Already finalized.');
    };
    return this;
  },
  addNode: function addNode(node) {
    console.assert(node);
    this._pushToNodes.call(this.nodes, node)
    this._pushToNodes.call(this.pos, this.nextPos.slice());
    this._pushToNodes.call(this.lasts, new Array(this.nextPos.length));
    for (var i = 0; i < this.nextPos.length; ++i) this.nextPos[i]++;
  },
  simplify: function() {
    this.finalize();
    return {nodes:this.nodes, pos:this.pos, lasts:this.lasts};
  }
};
function eachContext(nodeMultiSet) {
  var r = [];
  for (var i = 0; i < nodeMultiSet.nodes.length; i++) {
    var node = nodeMultiSet.nodes[i];
    if (!nodeMultiSet.pos) {
      r.push({nodes:[node], pos: [[i + 1]], lasts: [[nodeMultiSet.nodes.length]]});
    } else {
      for (var j = 0; j < nodeMultiSet.pos[i].length; ++j) {
        r.push({nodes:[node], pos: [[nodeMultiSet.pos[i][j]]], lasts: [[nodeMultiSet.lasts[i][j]]]});
      }
    }
  }
  return r;
}
/** Matcher used in the axes.
 */
function NodeMatcher(nodeTypeNum, nodeName, shouldLowerCase) {
  this.nodeTypeNum = nodeTypeNum;
  this.nodeName = nodeName;
  this.shouldLowerCase = shouldLowerCase;
  this.nodeNameTest =
    null == nodeName ? this._alwaysTrue :
    shouldLowerCase ? this._nodeNameLowerCaseEquals :
    this._nodeNameEquals;
}
NodeMatcher.prototype = {
  matches: function matches(node) {
    //console.log('matcher:',this.nodeTypeNum,' vs ',node.nodeType,'; ',this.nodeName,' vs ',node.nodeName)
    return (0 === this.nodeTypeNum || node.nodeType === this.nodeTypeNum) &&
        this.nodeNameTest(node.nodeName);
  },
  _alwaysTrue: function(name) {return true;},
  _nodeNameEquals: function _nodeNameEquals(name) {
    return this.nodeName === name;
  },
  _nodeNameLowerCaseEquals: function _nodeNameLowerCaseEquals(name) {
    return this.nodeName === name.toLowerCase();
  }
};

function followingHelper(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase, shift, peek, followingNode, andSelf, isReverseAxis) {
  var matcher = new NodeMatcher(nodeTypeNum, nodeName, shouldLowerCase);
  var nodeMultiSet = new NodeMultiSet(isReverseAxis);
  //console.log('followinghelper:nodeList=',nodeList.length);
  while (0 < nodeList.length) {  // can be if for following, preceding
    var node = shift.call(nodeList);
    console.assert(node != null);
    node = followingNode(node);
    nodeMultiSet.pushSeries();
    var numPushed = 1;
    while (null != node) {
      //console.log('trying ' + node.outerHTML);
      if (! andSelf && matcher.matches(node))
        nodeMultiSet.addNode(node);
      if (node === peek.call(nodeList)) {
        shift.call(nodeList);
        nodeMultiSet.pushSeries();
        numPushed++;
      }
      if (andSelf && matcher.matches(node))
        nodeMultiSet.addNode(node);
      node = followingNode(node);
    }
    while (0 < numPushed--)
      nodeMultiSet.popSeries();
  }
  return nodeMultiSet;
}
function followingNode(node) {
  if (null != node.firstChild)
    return node.firstChild;
  do {
    if (null != node.nextSibling) {
      return node.nextSibling;
    }
    node = node.parentNode;
  } while (node);
  return null;
}
function precedingNode(node) {
  if (null != node.previousSibling) {
    node = node.previousSibling;
    while (null != node.lastChild) {
      node = node.lastChild;
    }
    return node;
  }
  return node.parentNode;
}
/** node-set, axis -> node-set */
function descendantDfs(nodeMultiSet, node, remaining, matcher, andSelf) {
  if (null != node && !andSelf) {
    if (matcher.matches(node))
      nodeMultiSet.addNode(node);
  }
  var pushed = false;
  if (null == node) {
    if (0 === remaining.length) return;
    node = remaining.shift();
    nodeMultiSet.pushSeries();
    pushed = true;
  } else if (0 < remaining.length && node === remaining[0]) {
    nodeMultiSet.pushSeries();
    pushed = true;
    remaining.shift();
  }
  if (andSelf) {
    if (matcher.matches(node))
      nodeMultiSet.addNode(node);
  }
  // TODO: use optimization. Also try element.getElementsByTagName
  // var nodeList = 1 === nodeTypeNum && null != node.children ? node.children : node.childNodes;
  var nodeList = node.childNodes;
  for (var j = 0; j < nodeList.length; ++j) {
    var child = nodeList[j];
    descendantDfs(nodeMultiSet, child, remaining, matcher, andSelf);
  }
  if (pushed) {
    nodeMultiSet.popSeries();
  }
}
function descenantHelper(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase, andSelf) {
  var matcher = new NodeMatcher(nodeTypeNum, nodeName, shouldLowerCase);
  var nodeMultiSet = new NodeMultiSet(false);
  while (0 < nodeList.length) {
    // var node = nodeList.shift();
    descendantDfs(nodeMultiSet, null, nodeList, matcher, andSelf);
  }
  return nodeMultiSet.finalize();
}
/**
 */
function ancestorHelper(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase, andSelf) {
  var matcher = new NodeMatcher(nodeTypeNum, nodeName, shouldLowerCase);
  var ancestors = []; // array of array of ancestors
  for (var i = 0; i < nodeList.length; ++i) {
    var node = nodeList[i];
    var isFirst = true;
    var a = [];
    while (null != node) {
      if (!isFirst || andSelf) {
        if (matcher.matches(node))
          a.push(node);
      }
      isFirst = false;
      node = node.parentNode;
    }
    ancestors.push(a);
  }
  var lasts = [];
  for (var i = 0; i < ancestors.length; ++i) lasts.push(ancestors[i].length);
  var nodeMultiSet = new NodeMultiSet(true);
  var newCtx = {nodes:[], pos:[], lasts:[]};
  while (0 < ancestors.length) {
    var pos = [ancestors[0].length];
    var last = [lasts[0]];
    var node = ancestors[0].pop();
    for (var i = ancestors.length - 1; i > 0; --i) {
      if (node === ancestors[i][ancestors[i].length - 1]) {
        pos.push(ancestors[i].length);
        last.push(lasts[i]);
        ancestors[i].pop();
        if (0 === ancestors[i].length) {
          ancestors.splice(i, i+1);
          lasts.splice(i, i+1);
        }
      }
    }
    if (0 === ancestors[0].length) {
      ancestors.shift();
      lasts.shift();
    }
    newCtx.nodes.push(node);
    newCtx.pos.push(pos);
    newCtx.lasts.push(last);
  }
  return newCtx;
}
var axes = exp.axes = {
  'ancestor':
    function ancestor(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      return ancestorHelper(
        nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase, false);
    },
  'ancestor-or-self':
    function ancestorOrSelf(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      return ancestorHelper(
        nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase, true);
    },
  'attribute':
    function attribute(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      // TODO: figure out whether positions should be undefined here.
      var matcher = new NodeMatcher(nodeTypeNum, nodeName, shouldLowerCase);
      var nodeMultiSet = new NodeMultiSet(false);
      nodeMultiSet.pushSeries();
      if (null != nodeName) {
        // TODO: with namespace
        for (var i = 0; i < nodeList.length; ++i) {
          var node = nodeList[i];
          if (null == node.getAttributeNode) continue;  // only Element has .getAttributeNode
          var attr = node.getAttributeNode(nodeName);
          if (null == attr) continue;
          if (matcher.matches(attr))
            nodeMultiSet.addNode(attr);
        }
      } else {
        for (var i = 0; i < nodeList.length; ++i) {
          var node = nodeList[i];
          for (var j = 0; j < node.attributes.length; j++) {  // all nodes have .attributes
            var attr = node.attributes[j];
            if (matcher.matches(attr))  // TODO: I think this check is unnecessary
              nodeMultiSet.addNode(attr);
          }
        }
      }
      nodeMultiSet.popSeries();
      //console.log('Attribute axis returned ',stringifyContext(nodeMultiSet));
      return nodeMultiSet;
    },
  'child':
    function child(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      var matcher = new NodeMatcher(nodeTypeNum, nodeName, shouldLowerCase);
      var nodeMultiSet = new NodeMultiSet(false);
      for (var i = 0; i < nodeList.length; ++i) {
        var n = nodeList[i];
        if (n.childNodes) {
          nodeMultiSet.pushSeries();
          var childList = 1 === nodeTypeNum && null != n.children ? n.children : n.childNodes;
          for (var j = 0; j < childList.length; ++j) {
            var child = childList[j];
            if (matcher.matches(child)) {
              nodeMultiSet.addNode(child);
            }
            // don't have to do de-duping because children have parent,
            // which are current context.
          }
          nodeMultiSet.popSeries();
        }
      }
      return nodeMultiSet;
    },
  'descendant':
    function descenant(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      return descenantHelper(
        nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase, false);
    },
  'descendant-or-self':
    function descenantOrSelf(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      return descenantHelper(
        nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase, true);
    },
  'following':
    function following(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      return followingHelper(
        nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase,
        Array.prototype.shift,
        function() {return this[0];},
        followingNode);
    },
  'following-sibling':
    function followingSibling(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      return followingHelper(
        nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase,
        Array.prototype.shift, function() {return this[0];},
        function(node) {return node.nextSibling;});
    },
  'namespace':
    function namespace(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
    },
  'parent':
    function parent(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
    },
  'preceding':
    function preceding(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      return followingHelper(
        nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase,
        Array.prototype.pop, function() {return this[this.length-1];},
        precedingNode,
        false, true);
    },
  'preceding-sibling':
    function precedingSibling(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      return followingHelper(
        nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase,
        Array.prototype.pop, function() {return this[this.length-1];},
        function(node) {return node.previousSibling},
        false, true);
    },
  'self':
    function self(nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase) {
      return followingHelper(
          nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase,
          Array.prototype.shift, function() {return this[0];},
          function(node) {return null;},
          true);
    }
};
var fn = {
  number: function number(optObject) {
    if ('number' === typeof optObject)
      return optObject;
    if ('string' === typeof optObject)
      return parseFloat(optObject);  // note: parseFloat(' ') -> NaN, unlike +' ' -> 0.
    if ('boolean' === typeof optObject)
      return +optObject;
    return fn.number(this.string.call(this, optObject));  // for node-sets
  },
  string: function string(optObject) {
    if (null == typeof optObject)
      return fn.string(this);
    if ('string' === typeof optObject || 'boolean' === typeof optObject ||
        'number' === typeof optObject)
      return '' + optObject;
    return optObject.nodes.length ?
      optObject.nodes[0].textContent || optObject.nodes[0].nodeValue :
      '';
  },
  'boolean': function booleanVal(x) {
    return 'object' === typeof x ? x.nodes.length > 0 : !!x;
  },
  last: function last() {
    console.assert(Array.isArray(this.pos));
    console.assert(Array.isArray(this.lasts));
    console.assert(1 === this.pos.length);
    console.assert(1 === this.lasts.length);
    console.assert(1 === this.lasts[0].length);
    return this.lasts[0][0];
  },
  position: function position() {
    console.assert(Array.isArray(this.pos));
    console.assert(Array.isArray(this.lasts));
    console.assert(1 === this.pos.length);
    console.assert(1 === this.lasts.length);
    console.assert(1 === this.pos[0].length);
    return this.pos[0][0];
  },
  count: function count(nodeSet) {
    if ('object' !== typeof nodeSet)
      throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                               'Position ' + stream.position() +
                               ': Function count(node-set) ' +
                               'got wrong argument type: ' + nodeSet);
    return nodeSet.nodes.length;
  },
  id: function id(object) {
    var r = {nodes: []};
    var doc = this.nodes[0].ownerDocument;
    console.assert(doc);
    if ('object' === typeof object) {
      // for node-sets, map id over each node value.
      for (var i = 0; i < object.nodes.length; ++i) {
        var idNode = object.nodes[i];
        var id = fn.string({nodes:[idNode]});
        var node = doc.getElementById(id);
        if (null != node) r.nodes.push(node);
      }
    } else {
      var id = fn.string(object);
      var node = doc.getElementById(id);
      if (null != node) r.nodes.push(node);
    }
    return r;
  },
  'local-name': function(nodeSet) {
    // TODO
    throw new Error('not implemented yet');
  },
  'namespace-uri': function(nodeSet) {
    // TODO
    throw new Error('not implemented yet');
  },
  'name': function(nodeSet) {
    // TODO
    throw new Error('not implemented yet');
  },
  concat: function concat(x) {
    var l = [];
    for (var i = 0; i < arguments.length; ++i) {
      l.push(fn.string(arguments[i]));
    }
    return l.join('');
  },
  'starts-with': function startsWith(a, b) {
    var as = fn.string(a), bs = fn.string(b);
    return as.substr(0, bs.length) === bs;
  },
  'contains': function contains(a, b) {
    var as = fn.string(a), bs = fn.string(b);
    var i = as.indexOf(bs);
    if (-1 === i) return '';
    return as.substr(0, i);
  },
  'substring-before': function substringBefore(a, b) {
    var as = fn.string(a), bs = fn.string(b);
    var i = as.indexOf(bs);
    if (-1 === i) return '';
    return as.substr(i + bs.length);
  },
  'substring': function substring(string, start, optEnd) {
    var sString = fn.string(string),
        iStart = fn.number(start),
        iEnd = optEnd == null ? null : fn.number(optEnd);
    if (iEnd == null)
      return sString.substr(iStart);
    else
      return sString.substr(iStart, iEnd);
  },
  'string-length': function stringLength(optString) {
    return fn.string.call(this, optString).length;
  },
  'normalize-space': function normalizeSpace(optString) {
    var s = fn.string.call(this, optString);
    return s.replace(/[ \t\r\n]+/g, ' ').replace(/^ | $/g, '');
  },
  'translate': function translate(string, from, to) {
    var sString = fn.string.call(string),
        SFrom = fn.string(from),
        sTo = fn.string(to);
    var eachCharRe = [];
    var map = {};
    for (var i = 0; i < sFrom.length; ++i) {
      var c = sFrom.charAt(i);
      map[c] = sTo.charAt(i);  // returns '' if beyond length of sTo.
      // copied from goog.string.regExpEscape in the Closure library.
      eachCharRe.push(
        c.replace(/([-()\[\]{}+?*.$\^|,:#<!\\])/g, '\\$1').
          replace(/\x08/g, '\\x08'));
    }
    var re = new RegExp(eachCharRe.join('|'), 'g');
    return sString.replace(re, function(c) {return map[c];});
  },
  /// Boolean functions
  not: function not(x) {
    var bx = fn['boolean'](x);
    return !bx;
  },
  'true': function trueVal() { return true; },
  'false': function falseVal() { return false; },
  // TODO
  'lang': function lang(string) { throw new Error('Not implemented');},
  'sum': function sum(optNodeSet) {
    if (null == optNodeSet) return fn.sum(this);
    // for node-sets, map id over each node value.
    var sum = 0;
    for (var i = 0; i < optNodeSet.nodes.length; ++i) {
      var node = optNodeSet.nodes[i];
      var x = fn.number({nodes:[node]});
      sum += x;
    }
    return sum;
  },
  floor: function floor(number) {
    return Math.floor(fn.number(number));
  },
  ceiling: function ceiling(number) {
    return Math.ceil(fn.number(number));
  },
  round: function round(number) {
    return Math.round(fn.number(number));
  }
};
function comparisonHelper(test, x, y, isNumericComparison) {
  var coersion;
  if (isNumericComparison)
    coersion = fn.number;
  else coersion =
    'boolean' === typeof x || 'boolean' === typeof y ? fn['boolean'] :
    'number' === typeof x || 'number' === typeof y ? fn.number :
    fn.string;
  if ('object' === typeof x && 'object' === typeof y) {
    var aMap = {};
    for (var i = 0; i < x.nodes.length; ++i) {
      var xi = coersion({nodes:[x.nodes[i]]});
      for (var j = 0; j < y.nodes.length; ++j) {
        var yj = coersion({nodes:[y.nodes[j]]});
        if (test(xi, yj)) return true;
      }
    }
    return false;
  } else if ('object' === typeof x) {
    for (var i = 0; i < x.nodes.length; ++i) {
      var xi = coersion({nodes:[x.nodes[i]]}), yc = coersion(y);
      if (test(xi, yc))
        return true;
    }
    return false;
  } else if ('object' === typeof y) {
    for (var i = 0; i < x.nodes.length; ++i) {
      var yi = coersion({nodes:[y.nodes[i]]}), xc = coersion(x);
      if (test(xc, yi))
        return true;
    }
    return false;
  } else {
    var xc = coersion(x), yc = coersion(y);
    return test(xc, yc);
  }
}

/** Returns an array containing all the ancestors down to a node.
 * The array starts with document.
 */
function nodeAndAncestors(node) {
  var ancestors = [node];
  var p = node;
  while (p = p.parentNode) {
    ancestors.unshift(p);
  }
  return ancestors;
}
function compareSiblings(a, b) {
  if (a === b) return 0;
  var c = a;
  while (c = c.previousSibling) {
    if (c === b)
      return 1;  // b < a
  }
  c = b;
  while (c = c.previousSibling) {
    if (c === a)
      return -1;  // a < b
  }
  throw new Error('a and b are not siblings.');
}
/** The merge in merge-sort.*/
function mergeNodeLists(x, y) {
  var a, b, aanc, banc, r = [];
  while (true) {
    if (null == a) {
      a = x.shift();
      if (null == a) break;
      aanc = nodeAndAncestors(a);
    }
    if (null == b) {
      b = y.shift();
      if (null == b) break;
      banc = nodeAndAncestors(b);
    }
    var i = 0;
    var differingLevel = 0;
    while (aanc[i] === banc[i])
      i++;
    var c = aanc[i], d = banc[i];
    var comparison = compareSiblings(c, d);
    if (comparison < 0) { // c < d  => a < b
      r.push(a);
      a = null;
      aanc = null;
    } else {
      r.push(b);
      b = null;
      banc = null;
    }
  }
  while (a) {
    r.push(a);
    a = x.shift();
  }
  while (b) {
    r.push(b);
    b = y.shift();
  }
  return r;
}
var more = {
  UnaryMinus: function(x) { return -fn.number(x); },
  '+': function(x, y) { return fn.number(x) + fn.number(y); },
  '-': function(x, y) { return fn.number(x) - fn.number(y); },
  '*': function(x, y) { return fn.number(x) * fn.number(y); },
  'div': function(x, y) { return fn.number(x) / fn.number(y); },
  'mod': function(x, y) { return fn.number(x) % fn.number(y); },
  '<': function(x, y) {
    return comparisonHelper(function(x, y) { return fn.number(x) < fn.number(y);}, x, y, true);
  },
  '<=': function(x, y) {
    return comparisonHelper(function(x, y) { return fn.number(x) <= fn.number(y);}, x, y, true);
  },
  '>':  function(x, y) {
    return comparisonHelper(function(x, y) { return fn.number(x) > fn.number(y);}, x, y, true);
  },
  '>=': function(x, y) {
    return comparisonHelper(function(x, y) { return fn.number(x) >= fn.number(y);}, x, y, true);
  },
  'and': function(x, y) { return fn['boolean'](x) && fn['boolean'](y); },
  'or': function(x, y) { return fn['boolean'](x) || fn['boolean'](y); },
  '|': function(x, y) { return {nodes: mergeNodeLists(x.nodes, y.nodes)}; },
  '=': function(x, y) {
    // optimization for two node-sets case: avoid n^2 comparisons.
    if ('object' === typeof x && 'object' === typeof y) {
      var aMap = {};
      for (var i = 0; i < x.nodes.length; ++i) {
        var s = fn.string({nodes:[x.nodes[i]]});
        aMap[s] = true;
      }
      for (var i = 0; i < y.nodes.length; ++i) {
        var s = fn.string({nodes:[y.nodes[i]]});
        if (aMap[s]) return true;
      }
      return false;
    } else {
      return comparisonHelper(function(x, y) {return x === y;}, x, y);
    }
  },
  '!=': function(x, y) {
    // optimization for two node-sets case: avoid n^2 comparisons.
    if ('object' === typeof x && 'object' === typeof y) {
      if (0 === x.nodes.length || 0 === y.nodes.length) return false;
      var aMap = {};
      for (var i = 0; i < x.nodes.length; ++i) {
        var s = fn.string({nodes:[x.nodes[i]]});
        aMap[s] = true;
      }
      for (var i = 0; i < y.nodes.length; ++i) {
        var s = fn.string({nodes:[y.nodes[i]]});
        if (!aMap[s]) return true;
      }
      return false;
    } else {
      return comparisonHelper(function(x, y) {return x !== y;}, x, y);
    }
  }
};
var nodeTypes = exp.nodeTypes = {
  'node': 0,
  'attribute': 2,
  'comment': 8, // this.doc.COMMENT_NODE,
  'text': 3, // this.doc.TEXT_NODE,
  'processing-instruction': 7, // this.doc.PROCESSING_INSTRUCTION_NODE,
  'element': 1  //this.doc.ELEMENT_NODE
};
function stringifyContext(ctx) {
  var nicer = {};
  for (var key in ctx) {
    nicer[key] = ctx[key];
  }
  nicer.nodes = ctx.nodes.map(function(x) {return x.outerHTML || x.nodeValue;});
  return JSON.stringify(nicer);
}
function Evaluator(doc) {
  this.doc = doc;
}
Evaluator.prototype = {
  val: function val(ast, ctx) {
    //console.log('val ' + ast + ('object' === typeof ctx ? stringifyContext(ctx): ctx));

    if ('number' === typeof ast || 'string' === typeof ast) return ast;
    if (more[ast[0]]) {
      var evaluatedParams = [];
      for (var i = 1; i < ast.length; ++i) {
        evaluatedParams.push(this.val(ast[i], ctx));
      }
      return more[ast[0]].apply(ctx, evaluatedParams);
    }
    switch (ast[0]) {
      case 'Root': return {nodes: [this.doc]};
      case 'FunctionCall':
        var functionName = ast[1], functionParams = ast[2];
        if (null == fn[functionName])
          throw new XPathException(XPathException.INVALID_EXPRESSION_ERR,
                                   'Unknown function: ' + functionName);
        var evaluatedParams = [];
        for (var i = 0; i < functionParams.length; ++i) {
          evaluatedParams.push(this.val(functionParams[i], ctx));
        }
        return fn[functionName].apply(ctx, evaluatedParams);
      case 'Predicate':
        var lhs = this.val(ast[1], ctx);
        var ret = {nodes: []};
        var contexts = eachContext(lhs);
        for (var i = 0; i < contexts.length; ++i) {
          var singleNodeSet = contexts[i];
          //console.log('evaluating predicate: ' + ast[2] + ' within ' + stringifyContext(singleNodeSet));
          var rhs = this.val(ast[2], singleNodeSet);
          var success;
          if ('number' === typeof rhs) {
            success = rhs === singleNodeSet.pos[0][0];
          } else {
            success = fn['boolean'](rhs);
          }
          if (success) {
            var node = singleNodeSet.nodes[0];
            ret.nodes.push(node);
            // skip over all the rest of the same node.
            while (i+1 < contexts.length && node === contexts[i+1].nodes[0]) {
              i++;
            }
          }
        }
        return ret;
      case 'PathExpr':
        // turn the path into an expressoin; i.e., remove the position
        // information of the last axis.
        var x = this.val(ast[1], ctx);
        // Make the nodeset a forward-direction-only one.
        if (x.finalize) {  // it is a NodeMultiSet
          return {nodes: x.nodes};
        } else {
          return x;
        }
      case '/':
        // TODO: don't generate '/' nodes, just Axis nodes.
        var lhs = this.val(ast[1], ctx);
        return this.val(ast[2], lhs);
      case 'Axis':
        // All the axis tests from Step. We only get AxisSpecifier NodeTest,
        // not the predicate (which is applied later)
        var axis = ast[1],
            nodeType = ast[2],
            nodeTypeNum = nodeTypes[nodeType],
            shouldLowerCase = true,  // TODO: give option
            nodeName = ast[3] && shouldLowerCase ? ast[3].toLowerCase() : ast[3];
        nodeName = nodeName === '*' ? null : nodeName;
        if ('object' !== typeof ctx) return {nodes:[], pos:[]};
        var nodeList = ctx.nodes.slice();  // TODO: is copy needed?
        return axes[axis](nodeList  /*destructive!*/, nodeTypeNum, nodeName, shouldLowerCase);
    }
  }
};
function evaluateImpl(expr, doc, context) {
  //var astFactory = new AstEvaluatorFactory(doc, context);
  var stream = new Stream(expr);
  var ast = parse(stream, astFactory);
  return new Evaluator(doc).val(ast, {nodes: [context]});
  if ('object' === typeof ctx) return ctx.nodes;
  return ctx;
}

/***************************************************************************
 *                           DOM interface                                 *
 ***************************************************************************/

function XPathException(code, message) {
  this.name = 'XPathException';
  this.code = code;
  this.message = message;
  console.log(message);
}
XPathException.prototype.__proto__ = Error.prototype;
XPathException.INVALID_EXPRESSION_ERR = 51;
XPathException.TYPE_ERR = 52;
function XPathEvaluator() {
}
XPathEvaluator.prototype = {
  createExpression: function(expression, resolver) {
    return new XPathExpression(expression, resolver);
  },
  createNSResolver: function(nodeResolver) {
    // TODO
  },
  evaluate: function evaluate(expression, contextNode, resolver, type, result) {
    var expr = new XPathExpression(expression, resolver);
    return expr.evaluate(contextNode, type, result);
  }
};
function XPathExpression(expression, resolver, optDoc) {
  var stream = new Stream(expression);
  this._ast = parse(stream, astFactory);
  this._doc = optDoc;
}
XPathExpression.prototype = {
  evaluate: function evaluate(contextNode, type, result) {
    var doc = contextNode.ownerDocument || contextNode;
    if (null != this._doc && this._doc !== doc) {
      throw new core.DOMException(
          core.WRONG_DOCUMENT_ERR,
          'The document must be the same as the context node\'s document.');
    }
    var evaluator = new Evaluator(doc);
    var value = evaluator.val(this._ast, {nodes: [contextNode]});
    if (XPathResult.prototype.NUMBER_TYPE === type)
      value = fn.number(value);
    else if (XPathResult.prototype.STRING_TYPE === type)
      value = fn.string(value);
    else if (XPathResult.prototype.BOOLEAN_TYPE === type)
      value = fn['boolean'](value);
    else if (XPathResult.prototype.ANY_TYPE !== type &&
             XPathResult.prototype.UNORDERED_NODE_ITERATOR_TYPE !== type &&
             XPathResult.prototype.ORDERED_NODE_ITERATOR_TYPE !== type &&
             XPathResult.prototype.UNORDERED_NODE_SNAPSHOT_TYPE !== type &&
             XPathResult.prototype.ORDERED_NODE_SNAPSHOT_TYPE !== type &&
             XPathResult.prototype.ANY_UNORDERED_NODE_TYPE !== type &&
             XPathResult.prototype.FIRST_ORDERED_NODE_TYPE !== type)
      throw new core.DOMException(
          core.NOT_SUPPORTED_ERR,
          'You must provide an XPath result type (0=any).');
    else if (XPathResult.prototype.ANY_TYPE !== type &&
             'object' !== typeof value)
      throw new XPathException(XPathException.TYPE_ERR,
                               'Could not convert to node or node-set: ' + value);
    return new XPathResult(value, type);
  }
}
function XPathResult(value, resultType) {
  this._value = value;
  this._resultType = resultType;
  this._i = 0;
}
XPathResult.prototype = {
  // XPathResultType
  ANY_TYPE: 0,
  NUMBER_TYPE: 1,
  STRING_TYPE: 2,
  BOOLEAN_TYPE: 3,
  UNORDERED_NODE_ITERATOR_TYPE: 4,
  ORDERED_NODE_ITERATOR_TYPE: 5,
  UNORDERED_NODE_SNAPSHOT_TYPE: 6,
  ORDERED_NODE_SNAPSHOT_TYPE: 7,
  ANY_UNORDERED_NODE_TYPE: 8,
  FIRST_ORDERED_NODE_TYPE: 9,
  get resultType() {
    if (this._resultType) return this._resultType;
    switch (typeof this._value) {
      case 'number': return XPathResult.prototype.NUMBER_TYPE;
      case 'string': return XPathResult.prototype.STRING_TYPE;
      case 'boolean': return XPathResult.prototype.BOOLEAN_TYPE;
      default: return XPathResult.prototype.UNORDERED_NODE_ITERATOR_TYPE;
    }
  },
  get numberValue() {
    if (XPathResult.prototype.NUMBER_TYPE !== this.resultType)
      throw new XPathException(XPathException.TYPE_ERR,
                               'You should have asked for a NUMBER_TYPE.');
    return this._value;
  },
  get stringValue() {
    if (XPathResult.prototype.STRING_TYPE !== this.resultType)
      throw new XPathException(XPathException.TYPE_ERR,
                               'You should have asked for a STRING_TYPE.');
    return this._value;
  },
  get booleanValue() {
    if (XPathResult.prototype.BOOLEAN_TYPE !== this.resultType)
      throw new XPathException(XPathException.TYPE_ERR,
                               'You should have asked for a BOOLEAN_TYPE.');
    return this._value;
  },
  get singleNodeValue() {
    if (XPathResult.prototype.ANY_UNORDERED_NODE_TYPE !== this.resultType &&
        XPathResult.prototype.FIRST_ORDERED_NODE_TYPE !== this.resultType)
      throw new XPathException(XPathException.TYPE_ERR,
                               'You should have asked for a FIRST_ORDERED_NODE_TYPE.');
    return this._value.nodes[0] || null;
  },
  get invalidIteratorState() {
    if (XPathResult.prototype.UNORDERED_NODE_ITERATOR_TYPE !== this.resultType &&
        XPathResult.prototype.ORDERED_NODE_ITERATOR_TYPE !== this.resultType)
      return false;
    // TODO
    return false;
  },
  get snapshotLength() {
    if (XPathResult.prototype.UNORDERED_NODE_SNAPSHOT_TYPE !== this.resultType &&
        XPathResult.prototype.ORDERED_NODE_SNAPSHOT_TYPE !== this.resultType)
      throw new XPathException(XPathException.TYPE_ERR,
                               'You should have asked for a ORDERED_NODE_SNAPSHOT_TYPE.');
    return this._value.nodes.length;
  },
  iterateNext: function iterateNext() {
    if (XPathResult.prototype.UNORDERED_NODE_ITERATOR_TYPE !== this.resultType &&
        XPathResult.prototype.ORDERED_NODE_ITERATOR_TYPE !== this.resultType)
      throw new XPathException(XPathException.TYPE_ERR,
                               'You should have asked for a ORDERED_NODE_ITERATOR_TYPE.');
    if (this.invalidIteratorState)
      throw new core.DOMException(
          core.INVALID_STATE_ERR,
          'The document has been mutated since the result was returned');
    return this._value.nodes[this._i++] || null;
  },
  snapshotItem: function snapshotItem(index) {
    if (XPathResult.prototype.UNORDERED_NODE_SNAPSHOT_TYPE !== this.resultType &&
        XPathResult.prototype.ORDERED_NODE_SNAPSHOT_TYPE !== this.resultType)
      throw new XPathException(XPathException.TYPE_ERR,
                               'You should have asked for a ORDERED_NODE_SNAPSHOT_TYPE.');
    return this._value.nodes[index] || null;
  }
};

core.XPathException = XPathException;
core.XPathExpression = XPathExpression;
core.XPathResult = XPathResult;
core.XPathEvaluator = XPathEvaluator;
exp.dom = {
  level3: {
    xpath: core
  }
};
core.Document.prototype.createExpression = XPathEvaluator.prototype.createExpression;
core.Document.prototype.createNSResolver = XPathEvaluator.prototype.createNSResolver;
core.Document.prototype.evaluate = XPathEvaluator.prototype.evaluate;

console.log('done setting core.Document....');
})();
