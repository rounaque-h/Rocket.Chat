import stream from 'stream';
import fs from 'fs';
import path from 'path';

import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import mkdirp from 'mkdirp';

const mongo = MongoInternals.NpmModule;
const { db } = MongoInternals.defaultRemoteCollectionDriver().mongo;

const RocketChatFile = {};

RocketChatFile.bufferToStream = function (buffer) {
	const bufferStream = new stream.PassThrough();
	bufferStream.end(buffer);
	return bufferStream;
};

RocketChatFile.dataURIParse = function (dataURI) {
	const imageData = dataURI.split(';base64,');
	return {
		image: imageData[1],
		contentType: imageData[0].replace('data:', ''),
	};
};

RocketChatFile.addPassThrough = function (st, fn) {
	const pass = new stream.PassThrough();
	fn(pass, st);
	return pass;
};

RocketChatFile.GridFS = class {
	constructor(config = {}) {
		const { name = 'file', transformWrite } = config;

		this.name = name;
		this.transformWrite = transformWrite;

		this.bucket = new mongo.GridFSBucket(db, { bucketName: this.name });
	}

	async findOne(filename) {
		const file = await this.bucket.find({ filename }).limit(1).toArray();
		if (!file) {
			return;
		}
		return file[0];
	}

	async remove(fileId) {
		await this.bucket.delete(fileId);
	}

	createWriteStream(fileName, contentType) {
		const self = this;
		let ws = this.bucket.openUploadStream(fileName, {
			contentType,
		});

		if (self.transformWrite != null) {
			ws = RocketChatFile.addPassThrough(ws, function (rs, ws) {
				const file = {
					name: self.name,
					fileName,
					contentType,
				};
				return self.transformWrite(file, rs, ws);
			});
		}
		ws.on('close', function () {
			return ws.emit('end');
		});
		return ws;
	}

	createReadStream(fileName) {
		return this.bucket.openDownloadStreamByName(fileName);
	}

	async getFileWithReadStream(fileName) {
		const file = await this.findOne(fileName);
		if (file == null) {
			return null;
		}
		const rs = this.createReadStream(fileName);
		return {
			readStream: rs,
			contentType: file.contentType,
			length: file.length,
			uploadDate: file.uploadDate,
		};
	}

	async getFile(fileName) {
		const file = await this.getFileWithReadStream(fileName);
		if (!file) {
			return;
		}
		return new Promise((resolve) => {
			const data = [];
			file.readStream.on('data', function (chunk) {
				return data.push(chunk);
			});

			file.readStream.on('end', function () {
				resolve({
					buffer: Buffer.concat(data),
					contentType: file.contentType,
					length: file.length,
					uploadDate: file.uploadDate,
				});
			});
		});
	}

	async deleteFile(fileName) {
		const file = await this.findOne(fileName);
		if (file == null) {
			return undefined;
		}
		return this.remove(file._id);
	}
};

RocketChatFile.FileSystem = class {
	constructor(config = {}) {
		let { absolutePath = '~/uploads' } = config;
		const { transformWrite } = config;

		this.transformWrite = transformWrite;
		if (absolutePath.split(path.sep)[0] === '~') {
			const homepath = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
			if (homepath != null) {
				absolutePath = absolutePath.replace('~', homepath);
			} else {
				throw new Error('Unable to resolve "~" in path');
			}
		}
		this.absolutePath = path.resolve(absolutePath);
		mkdirp.sync(this.absolutePath);
		this.statSync = Meteor.wrapAsync(fs.stat.bind(fs));
		this.unlinkSync = Meteor.wrapAsync(fs.unlink.bind(fs));
		this.getFileSync = Meteor.wrapAsync(this.getFile.bind(this));
	}

	createWriteStream(fileName, contentType) {
		const self = this;
		let ws = fs.createWriteStream(path.join(this.absolutePath, fileName));
		if (self.transformWrite != null) {
			ws = RocketChatFile.addPassThrough(ws, function (rs, ws) {
				const file = {
					fileName,
					contentType,
				};
				return self.transformWrite(file, rs, ws);
			});
		}
		ws.on('close', function () {
			return ws.emit('end');
		});
		return ws;
	}

	createReadStream(fileName) {
		return fs.createReadStream(path.join(this.absolutePath, fileName));
	}

	stat(fileName) {
		return this.statSync(path.join(this.absolutePath, fileName));
	}

	remove(fileName) {
		return this.unlinkSync(path.join(this.absolutePath, fileName));
	}

	getFileWithReadStream(fileName) {
		try {
			const stat = this.stat(fileName);
			const rs = this.createReadStream(fileName);
			return {
				readStream: rs,
				// contentType: file.contentType
				length: stat.size,
			};
		} catch (error1) {
			return null;
		}
	}

	getFile(fileName, cb) {
		const file = this.getFileWithReadStream(fileName);
		if (!file) {
			return cb();
		}
		const data = [];
		file.readStream.on('data', function (chunk) {
			return data.push(chunk);
		});
		return file.readStream.on('end', function () {
			return {
				buffer: Buffer.concat(data)({
					contentType: file.contentType,
					length: file.length,
					uploadDate: file.uploadDate,
				}),
			};
		});
	}

	deleteFile(fileName) {
		try {
			return this.remove(fileName);
		} catch (error1) {
			return null;
		}
	}
};

export { RocketChatFile };
