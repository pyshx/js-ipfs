/* eslint max-nested-callbacks: ["error", 8] */
'use strict'

const { DAGNode, DAGLink, util } = require('ipld-dag-pb')
const CID = require('cids')
const map = require('async/map')
const series = require('async/series')
const parallel = require('async/parallel')
const eachLimit = require('async/eachLimit')
const waterfall = require('async/waterfall')
const detectLimit = require('async/detectLimit')
const { Key } = require('interface-datastore')
const errCode = require('err-code')
const multicodec = require('multicodec')

const createPinSet = require('./pin-set')
const Lock = require('./lock')

// arbitrary limit to the number of concurrent dag operations
const concurrencyLimit = 300
const PIN_DS_KEY = new Key('/local/pins')

function toB58String (hash) {
  return new CID(hash).toBaseEncodedString()
}

function invalidPinTypeErr (type) {
  const errMsg = `Invalid type '${type}', must be one of {direct, indirect, recursive, all}`
  return errCode(new Error(errMsg), 'ERR_INVALID_PIN_TYPE')
}

const PinTypes = {
  direct: 'direct',
  recursive: 'recursive',
  indirect: 'indirect',
  all: 'all'
}

class PinManager {
  constructor (repo, dag, repoOwner, log) {
    this.repo = repo
    this.dag = dag
    this.log = log
    this.pinset = createPinSet(dag)
    this.directPins = new Set()
    this.recursivePins = new Set()
    this._linkCache = {}
    this._lock = new Lock(repoOwner, 'ipfs:pin-manager:lock')
  }

  directKeys () {
    return Array.from(this.directPins).map(key => new CID(key).buffer)
  }

  recursiveKeys () {
    return Array.from(this.recursivePins).map(key => new CID(key).buffer)
  }

  getIndirectKeys (callback) {
    this._lock.readLock((lockCb) => {
      const indirectKeys = new Set()
      eachLimit(this.recursiveKeys(), concurrencyLimit, (multihash, cb) => {
        this.dag._getRecursive(multihash, (err, nodes) => {
          if (err) {
            return cb(err)
          }

          map(nodes, (node, cb) => util.cid(util.serialize(node), {
            cidVersion: 0
          }).then(cid => cb(null, cid), cb), (err, cids) => {
            if (err) {
              return cb(err)
            }

            cids
              .map(cid => cid.toString())
              // recursive pins pre-empt indirect pins
              .filter(key => !this.recursivePins.has(key))
              .forEach(key => indirectKeys.add(key))

            cb()
          })
        })
      }, (err) => {
        if (err) { return lockCb(err) }
        lockCb(null, Array.from(indirectKeys))
      })
    }, callback)
  }

  addRecursivePins (keys, callback) {
    this._addPins(keys, this.recursivePins, 'recursive', callback)
  }

  addDirectPins (keys, callback) {
    this._addPins(keys, this.directPins, 'direct', callback)
  }

  _addPins (keys, pinSet, pinType, callback) {
    this._lock.writeLock((lockCb) => {
      keys = keys.filter(key => !pinSet.has(key))
      if (!keys.length) return lockCb(null, [])

      delete this._linkCache[pinType]
      for (const key of keys) {
        pinSet.add(key)
      }
      this._flushPins(lockCb)
    }, callback)
  }

  rmPins (keys, recursive, callback) {
    if (!keys.length) return callback(null, [])

    this._lock.writeLock((lockCb) => {
      for (const key of keys) {
        if (recursive && this.recursivePins.has(key)) {
          this.recursivePins.delete(key)
        } else {
          this.directPins.delete(key)
        }
      }

      this._flushPins(lockCb)
    }, callback)
  }

  // Encode and write pin key sets to the datastore:
  // a DAGLink for each of the recursive and direct pinsets
  // a DAGNode holding those as DAGLinks, a kind of root pin
  // Note: should only be called within a lock
  _flushPins (callback) {
    let root
    let dLink = this._linkCache['direct']
    let rLink = this._linkCache['recursive']

    series([
      // create a DAGLink to the node with direct pins
      cb => parallel([
        pcb => {
          if (dLink) return pcb(null)

          this.pinset.storeSet(this.directKeys(), 'direct', (err, res) => {
            if (err) return pcb(err)

            const { node, cid } = res
            try {
              dLink = new DAGLink(PinTypes.direct, node.size, cid)
              this._linkCache['direct'] = dLink
              pcb(null)
            } catch (err) {
              pcb(err)
            }
          })
        },

        // create a DAGLink to the node with recursive pins
        pcb => {
          if (rLink) return pcb(null)

          this.pinset.storeSet(this.recursiveKeys(), 'recursive', (err, res) => {
            if (err) return pcb(err)

            const { node, cid } = res
            try {
              rLink = new DAGLink(PinTypes.recursive, node.size, cid)
              this._linkCache['recursive'] = rLink
              pcb(null)
            } catch (err) {
              pcb(err)
            }
          })
        },

        // the pin-set nodes link to a special 'empty' node, so make sure it exists
        pcb => {
          let empty

          try {
            empty = DAGNode.create(Buffer.alloc(0))
          } catch (err) {
            return pcb(err)
          }

          this.dag.put(empty, {
            version: 0,
            format: multicodec.DAG_PB,
            hashAlg: multicodec.SHA2_256,
            preload: false
          }, pcb)
        }
      ], cb),

      // create a root node with DAGLinks to the direct and recursive DAGs
      cb => {
        let node

        try {
          node = DAGNode.create(Buffer.alloc(0), [dLink, rLink])
        } catch (err) {
          return cb(err)
        }

        root = node
        this.dag.put(root, {
          version: 0,
          format: multicodec.DAG_PB,
          hashAlg: multicodec.SHA2_256,
          preload: false
        }, (err, cid) => {
          if (!err) {
            root.multihash = cid.buffer
          }
          cb(err)
        })
      },

      // hack for CLI tests
      cb => this.repo.closed ? this.repo.open(cb) : cb(null, null),

      // save root to datastore under a consistent key
      cb => this.repo.datastore.put(PIN_DS_KEY, root.multihash, cb)
    ], (err, res) => {
      if (err) { return callback(err) }
      this.log(`Flushed pins with root: ${root}`)
      return callback(null, root)
    })
  }

  load (callback) {
    this._lock.writeLock((lockCb) => {
      waterfall([
        // hack for CLI tests
        (cb) => this.repo.closed ? this.repo.datastore.open(cb) : cb(null, null),
        (_, cb) => this.repo.datastore.has(PIN_DS_KEY, cb),
        (has, cb) => has ? cb() : cb(new Error('No pins to load')),
        (cb) => this.repo.datastore.get(PIN_DS_KEY, cb),
        (mh, cb) => {
          this.dag.get(new CID(mh), '', { preload: false }, cb)
        }
      ], (err, pinRoot) => {
        if (err) {
          if (err.message === 'No pins to load') {
            this.log('No pins to load')
            return lockCb()
          } else {
            return lockCb(err)
          }
        }

        parallel([
          cb => this.pinset.loadSet(pinRoot.value, PinTypes.recursive, cb),
          cb => this.pinset.loadSet(pinRoot.value, PinTypes.direct, cb)
        ], (err, keys) => {
          if (err) { return lockCb(err) }
          const [ rKeys, dKeys ] = keys

          this.directPins = new Set(dKeys.map(toB58String))
          this.recursivePins = new Set(rKeys.map(toB58String))

          this.log('Loaded pins from the datastore')
          return lockCb(null)
        })
      })
    }, callback)
  }

  isPinnedWithType (multihash, type, callback) {
    const key = toB58String(multihash)
    const { recursive, direct, all } = PinTypes

    // recursive
    if ((type === recursive || type === all) && this.recursivePins.has(key)) {
      return callback(null, {
        key,
        pinned: true,
        reason: recursive
      })
    }

    if (type === recursive) {
      return callback(null, {
        key,
        pinned: false
      })
    }

    // direct
    if ((type === direct || type === all) && this.directPins.has(key)) {
      return callback(null, {
        key,
        pinned: true,
        reason: direct
      })
    }

    if (type === direct) {
      return callback(null, {
        key,
        pinned: false
      })
    }

    this._lock.readLock((lockCb) => {
      // indirect (default)
      // check each recursive key to see if multihash is under it
      // arbitrary limit, enables handling 1000s of pins.
      detectLimit(this.recursiveKeys().map(key => new CID(key)), concurrencyLimit, (cid, cb) => {
        waterfall([
          (done) => this.dag.get(cid, '', { preload: false }, done),
          (result, done) => done(null, result.value),
          (node, done) => this.pinset.hasDescendant(node, key, done)
        ], cb)
      }, (err, cid) => lockCb(err, {
        key,
        pinned: Boolean(cid),
        reason: cid
      }))
    }, callback)
  }

  // Gets CIDs of blocks used internally by the pinner
  getInternalBlocks (callback) {
    this._lock.writeLock((lockCb) => {
      this.repo.datastore.get(PIN_DS_KEY, (err, mh) => {
        if (err) {
          if (err.code === 'ERR_NOT_FOUND') {
            this.log(`No pinned blocks`)
            return lockCb(null, [])
          }
          return lockCb(new Error(`Could not get pin sets root from datastore: ${err.message}`))
        }

        const cid = new CID(mh)
        this.dag.get(cid, '', { preload: false }, (err, obj) => {
          if (err) {
            return lockCb(new Error(`Could not get pin sets from store: ${err.message}`))
          }

          // The pinner stores an object that has two links to pin sets:
          // 1. The directly pinned CIDs
          // 2. The recursively pinned CIDs
          // If large enough, these pin sets may have links to buckets to hold
          // the pins
          this.pinset.getInternalCids(obj.value, (err, cids) => {
            if (err) {
              return lockCb(new Error(`Could not get pinner internal cids: ${err.message}`))
            }

            lockCb(null, cids.concat(cid))
          })
        })
      })
    }, callback)
  }

  // Returns an error if the pin type is invalid
  static checkPinType (type) {
    if (typeof type !== 'string' || !Object.keys(PinTypes).includes(type)) {
      return invalidPinTypeErr(type)
    }
  }
}

PinManager.PinTypes = PinTypes

module.exports = PinManager