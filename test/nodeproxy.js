var vows = require('vows'),
    core = require('../lib/jsdom/level1/core').dom.level1.core,
    assert = require('assert');

vows.describe('node-proxy').addBatch({
    "The Assertion module": {
        topic: core.createArrayLike(new core.NodeList({_version:0}, function() {return [1,2,3,4,5,6,7,8,9,0];})),
        "`equal`": function (n) {
          for (var i = 0; i < 100000; i++) {
          assert.equal(10, n.length);
          assert.equal(2, n.item(1));
          assert.equal(1, n.item(0));
          assert.equal(3, n.item(2));
          assert.equal(4, n.item(3));
          assert.equal(5, n.item(4));
          assert.equal(6, n.item(5));
          assert.equal(7, n.item(6));
          }
        },
        /*
        "`equal2`": function (n) {
          for (var i = 0; i < 100000; i++) {
          assert.equal(10, n.length);
          assert.equal(2, n[1]);
          assert.equal(1, n[0]);
          assert.equal(3, n[2]);
          assert.equal(4, n[3]);
          assert.equal(5, n[4]);
          assert.equal(6, n[5]);
          assert.equal(7, n[6]);
          }
        },
        */
        /*
        
        'another': function(n) {
          for (var i = 0; i < 1000000; i++) {
            assert.equal(undefined, n['zz' + i]);
          }
        },
        'single': function(n) {
          console.log('[0]:');
          assert.equal(1, n[0]);
          console.log('item(0):');
          assert.equal(1, n.item(0));
        },
        */
    }
}).export(module);

