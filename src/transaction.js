// @flow

import invariant from 'assert';
import * as BufferLayout from 'buffer-layout';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

import * as Layout from './layout';
import {PublicKey} from './publickey';
import {Account} from './account';

/**
 * @typedef {string} TransactionSignature
 */
export type TransactionSignature = string;

/**
 * @typedef {string} TransactionId
 */
export type TransactionId = string;

/**
 * Maximum over-the-wire size of a Transaction
 */
export const PACKET_DATA_SIZE = 512;

/**
 * List of TransactionInstruction object fields that may be initialized at construction
 *
 * @typedef {Object} TransactionInstructionCtorFields
 * @property {?Array<PublicKey>} keys
 * @property {?PublicKey} programId
 * @property {?Buffer} userdata
 */
type TransactionInstructionCtorFields = {|
  keys?: Array<PublicKey>,
  programId?: PublicKey,
  userdata?: Buffer,
|};

/**
 * Transaction Instruction class
 */
export class TransactionInstruction {
  /**
   * Public keys to include in this transaction
   */
  keys: Array<PublicKey> = [];

  /**
   * Program Id to execute
   */
  programId: PublicKey;

  /**
   * Program input
   */
  userdata: Buffer = Buffer.alloc(0);

  constructor(opts?: TransactionInstructionCtorFields) {
    opts && Object.assign(this, opts);
  }
}

/**
 * @private
 */
type SignaturePubkeyPair = {|
  signature: Buffer | null,
  publicKey: PublicKey,
|};

/**
 * List of Transaction object fields that may be initialized at construction
 *
 * @typedef {Object} TransactionCtorFields
 * @property {?number} fee
 * @property (?lastId} A recent transaction id
 * @property (?signatures} One or more signatures
 *
 */
type TransactionCtorFields = {|
  fee?: number,
  lastId?: TransactionId,
  signatures?: Array<SignaturePubkeyPair>,
|};

/**
 * Transaction class
 */
export class Transaction {
  /**
   * Signatures for the transaction.  Typically created by invoking the
   * `sign()` method
   */
  signatures: Array<SignaturePubkeyPair> = [];

  /**
   * The first (primary) Transaction signature
   */
  get signature(): Buffer | null {
    if (this.signatures.length > 0) {
      return this.signatures[0].signature;
    }
    return null;
  }

  /**
   * The instructions to atomically execute
   */
  instructions: Array<TransactionInstruction> = [];

  /**
   * A recent transaction id.  Must be populated by the caller
   */
  lastId: ?TransactionId;

  /**
   * Fee for this transaction
   */
  fee: number = 1;

  /**
   * Construct an empty Transaction
   */
  constructor(opts?: TransactionCtorFields) {
    opts && Object.assign(this, opts);
  }

  /**
   * Add one or more instructions to this Transaction
   */
  add(
    ...items: Array<Transaction | TransactionInstructionCtorFields>
  ): Transaction {
    if (items.length === 0) {
      throw new Error('No instructions');
    }

    items.forEach(item => {
      if (item instanceof Transaction) {
        this.instructions = this.instructions.concat(item.instructions);
      } else {
        this.instructions.push(new TransactionInstruction(item));
      }
    });
    return this;
  }

  /**
   * @private
   */
  _getSignData(): Buffer {
    const {lastId} = this;
    if (!lastId) {
      throw new Error('Transaction lastId required');
    }

    if (this.instructions.length < 1) {
      throw new Error('No instructions provided');
    }

    const keys = this.signatures.map(({publicKey}) => publicKey.toString());
    const programIds = [];
    this.instructions.forEach(instruction => {
      const programId = instruction.programId.toString();
      if (!programIds.includes(programId)) {
        programIds.push(programId);
      }

      instruction.keys.map(key => key.toString()).forEach(key => {
        if (!keys.includes(key)) {
          keys.push(key);
        }
      });
    });

    const instructions = this.instructions.map(instruction => {
      const {userdata, programId} = instruction;
      return {
        programIdIndex: programIds.indexOf(programId.toString()),
        keyIndices: instruction.keys.map(key => keys.indexOf(key.toString())),
        userdata,
      };
    });

    instructions.forEach(instruction => {
      invariant(instruction.programIdIndex >= 0);
      instruction.keyIndices.forEach(keyIndex => invariant(keyIndex >= 0));
    });

    const instructionLayout = BufferLayout.struct([
      BufferLayout.u8('programIdIndex'),

      BufferLayout.u32('keyIndicesLength'),
      BufferLayout.u32('keyIndicesLengthPadding'),
      BufferLayout.seq(
        BufferLayout.u8('keyIndex'),
        BufferLayout.offset(BufferLayout.u32(), -8),
        'keyIndices',
      ),
      BufferLayout.u32('userdataLength'),
      BufferLayout.u32('userdataLengthPadding'),
      BufferLayout.seq(
        BufferLayout.u8('userdatum'),
        BufferLayout.offset(BufferLayout.u32(), -8),
        'userdata',
      ),
    ]);

    const signDataLayout = BufferLayout.struct([
      BufferLayout.u32('keysLength'),
      BufferLayout.u32('keysLengthPadding'),
      BufferLayout.seq(
        Layout.publicKey('key'),
        BufferLayout.offset(BufferLayout.u32(), -8),
        'keys',
      ),
      Layout.publicKey('lastId'),
      BufferLayout.ns64('fee'),

      BufferLayout.u32('programIdsLength'),
      BufferLayout.u32('programIdsLengthPadding'),
      BufferLayout.seq(
        Layout.publicKey('programId'),
        BufferLayout.offset(BufferLayout.u32(), -8),
        'programIds',
      ),

      BufferLayout.u32('instructionsLength'),
      BufferLayout.u32('instructionsLengthPadding'),
      BufferLayout.seq(
        instructionLayout,
        BufferLayout.offset(BufferLayout.u32(), -8),
        'instructions',
      ),
    ]);

    const transaction = {
      keys: keys.map(key => new PublicKey(key).toBuffer()),
      lastId: Buffer.from(bs58.decode(lastId)),
      fee: this.fee,
      programIds: programIds.map(programId =>
        new PublicKey(programId).toBuffer(),
      ),
      instructions,
    };

    let signData = Buffer.alloc(2048);
    const length = signDataLayout.encode(transaction, signData);
    signData = signData.slice(0, length);

    return signData;
  }

  /**
   * Sign the Transaction with the specified accounts.  Multiple signatures may
   * be applied to a Transaction. The first signature is considered "primary"
   * and is used when testing for Transaction confirmation.
   *
   * Transaction fields should not be modified after the first call to `sign`,
   * as doing so may invalidate the signature and cause the Transaction to be
   * rejected.
   *
   * The Transaction must be assigned a valid `lastId` before invoking this method
   */
  sign(...signers: Array<Account>) {
    this.signPartial(...signers);
  }

  /**
   * Partially sign a Transaction with the specified accounts.  The `Account`
   * inputs will be used to sign the Transaction immediately, while any
   * `PublicKey` inputs will be referenced in the signed Transaction but need to
   * be filled in later by calling `addSigner()` with the matching `Account`.
   *
   * All the caveats from the `sign` method apply to `signPartial`
   */
  signPartial(...partialSigners: Array<PublicKey | Account>) {
    if (partialSigners.length === 0) {
      throw new Error('No signers');
    }
    const signatures: Array<SignaturePubkeyPair> = partialSigners.map(
      accountOrPublicKey => {
        const publicKey =
          accountOrPublicKey instanceof Account
            ? accountOrPublicKey.publicKey
            : accountOrPublicKey;
        return {
          signature: null,
          publicKey,
        };
      },
    );
    this.signatures = signatures;
    const signData = this._getSignData();

    partialSigners.forEach((accountOrPublicKey, index) => {
      if (accountOrPublicKey instanceof PublicKey) {
        return;
      }
      const signature = nacl.sign.detached(
        signData,
        accountOrPublicKey.secretKey,
      );
      invariant(signature.length === 64);
      signatures[index].signature = signature;
    });
  }

  /**
   * Fill in a signature for a partially signed Transaction.  The `signer` must
   * be the corresponding `Account` for a `PublicKey` that was previously provided to
   * `signPartial`
   */
  addSigner(signer: Account) {
    const index = this.signatures.findIndex(sigpair =>
      signer.publicKey.equals(sigpair.publicKey),
    );
    if (index < 0) {
      throw new Error(`Unknown signer: ${signer.publicKey.toString()}`);
    }

    const signData = this._getSignData();
    const signature = nacl.sign.detached(signData, signer.secretKey);
    invariant(signature.length === 64);
    this.signatures[index].signature = signature;
  }

  /**
   * Serialize the Transaction in the wire format.
   *
   * The Transaction must have a valid `signature` before invoking this method
   */
  serialize(): Buffer {
    const {signatures} = this;
    if (!signatures) {
      throw new Error('Transaction has not been signed');
    }

    const signData = this._getSignData();
    const wireTransaction = Buffer.alloc(
      8 + signatures.length * 64 + signData.length,
    );
    invariant(signatures.length < 256);
    wireTransaction.writeUInt8(signatures.length, 0);
    signatures.forEach(({signature}, index) => {
      invariant(signature !== null, `null signature`);
      invariant(signature.length === 64, `signature has invalid length`);
      Buffer.from(signature).copy(wireTransaction, 8 + index * 64);
    });
    signData.copy(wireTransaction, 8 + signatures.length * 64);
    invariant(
      wireTransaction.length <= PACKET_DATA_SIZE,
      `Transaction too large: ${wireTransaction.length} > ${PACKET_DATA_SIZE}`,
    );
    return wireTransaction;
  }

  /**
   * Deprecated method
   * @private
   */
  get keys(): Array<PublicKey> {
    invariant(this.instructions.length === 1);
    return this.instructions[0].keys;
  }

  /**
   * Deprecated method
   * @private
   */
  get programId(): PublicKey {
    invariant(this.instructions.length === 1);
    return this.instructions[0].programId;
  }

  /**
   * Deprecated method
   * @private
   */
  get userdata(): Buffer {
    invariant(this.instructions.length === 1);
    return this.instructions[0].userdata;
  }
}
